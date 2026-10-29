"""Agentic RAG 状态图（LangGraph）。

图结构与架构图一致：

    START → rewrite → retrieve → grade
      grade ── 充分 ─────────────────────────────→ generate → check
        ├─ 不足且未到上限 → rewrite
        └─ 到上限 → fallback → generate → END
      check ── 通过 / 已到上限 → END
        └─ 不通过且未到上限 → notice（清空上一版）→ generate

设计原则：
- 节点全部复用现有检索/生成函数，不复制业务逻辑；
- 通过 ContextVar 注入 AsyncSession，避免把不可序列化的数据库会话塞进图状态；
- token 通过 get_stream_writer() 以 custom 事件发出，外层 rule_qa 转成 SSE；
- 任何节点抛错由 rule_qa 决定是否回落旧流水线，图本身不吞异常。
"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import Any, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import llm, rule_qa
from app.core.config import settings

log = logging.getLogger(__name__)


class RAGState(TypedDict, total=False):
    message: str
    history: list[tuple[str, str]]
    game_id: int | None
    game_hint: str | None
    dialogue_state: dict
    query: str
    retrieval_attempts: int
    check_attempts: int
    level: int
    label: str
    context: str
    game_name: str | None
    resolved_game_id: int | None
    citations: list[dict]
    answer: str
    chars: int
    strict: bool
    fallback: bool
    grade: str
    check_passed: bool


# 数据库会话按协程上下文注入；LangGraph 的异步节点会继承同一 contextvars 上下文。
_db_ctx: ContextVar[AsyncSession | None] = ContextVar("agentic_rag_db", default=None)


def _db() -> AsyncSession:
    db = _db_ctx.get()
    if db is None:
        raise RuntimeError("Agentic RAG 未注入数据库会话")
    return db


def _emit(kind: str, payload: dict | None = None, **extra: Any) -> None:
    """向 LangGraph 的 custom 流写一个事件；非流式/无 writer 时静默跳过。"""
    try:
        writer = get_stream_writer()
    except Exception:  # noqa: BLE001 - 非图上下文取 writer 会抛错
        return
    if writer is None:
        return
    event: dict[str, Any] = {"type": kind}
    if payload is not None:
        event["payload"] = payload
    event.update(extra)
    try:
        writer(event)
    except Exception:  # noqa: BLE001 - 流已关闭时忽略
        pass


# 检索重试时逐次加不同的规则书措辞；只改查询，不改主题游戏。
_RETRY_SUFFIXES = (
    "",
    "规则 玩法 流程 回合 行动",
    "说明书 计分 胜负 配件 结算",
    "详细规则 准备阶段 示例 常见问题",
)


async def _rewrite(state: RAGState) -> dict:
    """第一次用原问题；之后按重试次数叠加规则书措辞。"""
    attempts = int(state.get("retrieval_attempts", 0))
    base = (state.get("message") or "").strip()
    suffix = _RETRY_SUFFIXES[min(attempts, len(_RETRY_SUFFIXES) - 1)]
    query = f"{base} {suffix}".strip() if suffix else base
    if attempts > 0:
        _emit("info", {"text": f"检索依据不足，正在换一种问法（第 {attempts + 1} 次）…"})
    return {"query": query, "retrieval_attempts": attempts + 1}


async def _retrieve(state: RAGState) -> dict:
    """分层检索，并把层级与引用片段发给前端。"""
    level, context, game, citations = await rule_qa.retrieve_layered_with_citations(
        _db(),
        state.get("message") or "",
        query=state.get("query"),
        game_id=state.get("game_id"),
        game_hint=state.get("game_hint"),
        history=state.get("history"),
        dialogue_state=state.get("dialogue_state"),
    )
    label = rule_qa.LEVEL_LABEL.get(level, "")
    _emit(
        "level",
        {
            "level": level,
            "label": label,
            "game": game.name if game else None,
            "game_id": game.id if game else None,
        },
    )
    if citations:
        _emit("citations", {"items": citations, "count": len(citations)})
    return {
        "level": level,
        "label": label,
        "context": context,
        "game_name": game.name if game else None,
        "resolved_game_id": game.id if game else None,
        "citations": citations,
    }


# 规则细节类提问：L1 结构化资料通常不够，需要规则书原文。
_RULE_DETAIL_PAT = re.compile(
    r"怎么玩|怎么打|规则|玩法|流程|回合|行动|阶段|计分|得分|胜负|获胜|胜利|"
    r"配件|组件|卡牌|骰子|拿取|放置|结算|准备|新手|教学|教程|详细|具体"
)

# 回答自报「站内没有」= 站内资料只覆盖了一部分，此时才值得去站外补一次。
# 注意排除「整款游戏不在候选池」——那属于范围外，靠明确声明 + 建议处理，不做站外检索。
_OUT_OF_POOL_PAT = re.compile(r"不在本站候选池|不在候选池")
_MISSING_PAT = re.compile(
    r"本站暂无|暂无该信息|暂无相关信息|未收录|未记载|未提及|未说明|未写明|未列出|"
    r"未覆盖|没有覆盖|未涉及|"
    r"资料(?:中|里)?(?:没有|未提及|没提到)|没有(?:相关)?(?:资料|记录)"
)

_EXTERNAL_SYSTEM_PROMPT = """你是 TableMind 的站外资料补充助手。
站内规则资料没有覆盖用户问的细节，请联网检索公开资料，**只补全用户问到的那个细节**。

0. 这是桌游规则问题：只回答该桌游规则书里的内容（时代/阶段/牌面/结算等），
   禁止用现实世界的同名事物作答（如问《工业革命：伯明翰》的「运河时代」，
   答的是游戏里的阶段，不是现实中的运河运输史）。

1. 必须先联网检索，只依据检索到的公开资料作答；与你的记忆冲突时以检索结果为准，
   不确定就输出「未找到可靠记载」，禁止凭印象编造数值或技能效果。
2. 完整性优先：用户问「有哪些 / 清单 / 全部 / 一览」时必须尽量穷举，不能只列一部分；
   检索结果不足以给全时，明确说明「以上为可确认的部分」，不得静默少列。
3. 只输出答案本身：用户问的是哪一项就答哪一项，不要扩展到无关内容，也不要重复站内已有的说明。
4. 规则细节要给全：提到某个牌/技能/机制，必须连带说明它的关键规则
   （效果、触发时机、生效范围、数值或限制），不能只给名称或分类。
5. 禁止任何过程说明：不要出现「根据资料」「检索到」「站内/站外」「未收录」这类字眼，
   不要「注：」「说明：」「补充：」、不要来源清单、不要筛选或比对过程。
6. 禁止在结尾反问用户或推销后续（如「需要我帮你整理…吗」）；用户没问的内容不要提。
7. 纯文本，禁止 Markdown（不要 *、#、>、- 列表，也不要 emoji）。"""

# 站外结果无效（也没查到 / 只是把站内边界复述一遍）：不清屏，保留站内回答
_EXTERNAL_MISS_PAT = re.compile(
    r"未找到可靠|未找到相关|没有找到|未检索到|无法(?:确认|找到)|"
    r"未在.*(?:出现|收录)|不在.*候选池|本站未收录"
)


def _parse_json(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def _as_bool(obj: dict, key: str, default: bool = True) -> bool:
    value = obj.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1", "是", "通过", "支持")
    return default


async def _llm_grade(message: str, context: str) -> bool:
    """由 LLM 判定资料是否足以回答；失败时按充分处理，避免误触发重试。

    判据是「资料里出现了问题所问的那个东西」，不是「这是同一款游戏的资料」。
    实测：问《抵抗组织：阿瓦隆》的梅林/刺客，检索命中的其实是《抵抗组织》
    基础版说明书（标题相同、正文是基础版规则）；旧逻辑「有引用即充分」会
    让模型硬答，最后输出一大段「资料里没有梅林…候选池里有…」的论证，既没
    回答问题，也给了错误结论。
    """
    prompt = [
        {
            "role": "system",
            "content": (
                "你是检索质量评审。判断这些资料能否真正回答用户的问题。"
                "只有资料中出现了问题所问的**具体对象**（角色名 / 卡牌名 / 机制名 / "
                "阶段名 / 具体数值），并能据此给出答案时，才判 sufficient=true；"
                "资料只是同一款游戏或同系列的通用介绍、没有提到该对象，判 false。"
                '只输出 JSON：{"sufficient": true} 或 {"sufficient": false}。'
            ),
        },
        {
            "role": "user",
            "content": f"问题：{message}\n\n资料：\n{context[:2500]}",
        },
    ]
    try:
        raw = await llm.chat_complete(
            prompt,
            temperature=0.0,
            # DeepSeek V4 默认带思维链，120 token 会被思维链吃光、正文为空，
            # 解析失败又回落到「充分」，等于判定失效 → 给足预算。
            max_tokens=600,
            model=settings.LLM_FAST_MODEL or settings.LLM_MODEL,
            enable_thinking=False,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("检索充分性判定失败，按充分处理：%s", e)
        return True
    return _as_bool(_parse_json(raw), "sufficient", True)


async def _grade(state: RAGState) -> dict:
    """判断检索结果是否足以生成；L2 规则书命中即视为充分。"""
    level = int(state.get("level", 4))
    citations = state.get("citations") or []
    message = state.get("message") or ""
    context = state.get("context") or ""

    if level in (2, 3):
        # L2/L3 有引用不代表答得出：语料可能只覆盖同一款游戏的通用部分。
        # 交给 LLM 判「资料里是否出现所问对象」，判不出就走 L4 → 站外补充。
        sufficient = bool(citations) and await _llm_grade(message, context)
    elif level == 1:
        # 结构化资料能答概况，但答不了「怎么玩 / 计分 / 流程」这类规则细节
        sufficient = not bool(_RULE_DETAIL_PAT.search(message))
        if sufficient and settings.AGENTIC_GRADE_LLM_ENABLED:
            sufficient = await _llm_grade(message, context)
    else:
        sufficient = False

    if sufficient:
        return {"grade": "sufficient"}

    attempts = int(state.get("retrieval_attempts", 0))
    if attempts < max(1, settings.AGENTIC_MAX_RETRIES):
        return {"grade": "insufficient"}
    return {"grade": "exhausted"}


async def _generate(state: RAGState) -> dict:
    """流式生成；token 通过 custom 事件发出。"""
    db = _db()
    level = int(state.get("level", 4))
    label = state.get("label") or rule_qa.LEVEL_LABEL.get(level, "")

    prompt_msgs = await rule_qa.build_generation_messages(
        db,
        state.get("message") or "",
        state.get("history"),
        state.get("context") or "",
        label,
        strict=bool(state.get("strict")),
        fallback=bool(state.get("fallback")),
    )

    total = 0
    buf: list[str] = []
    try:
        async for kind, piece in llm.chat_stream(
            prompt_msgs,
            temperature=0.3,
            max_tokens=rule_qa.MAX_TOKENS,
            model=settings.LLM_RULE_MODEL or settings.LLM_MODEL,
            enable_thinking=settings.LLM_RULE_THINKING,
        ):
            if kind == "content" and piece:
                total += len(piece)
                buf.append(piece)
                _emit("delta", text=piece)
    except llm.LLMError as e:  # noqa: BLE001
        log.warning("规则问答生成失败：%s", e)
        raise

    if total == 0:
        raise RuntimeError(
            "规则问答未生成任何正文（疑似推理模型思维链耗尽 token 预算）"
        )
    return {"answer": "".join(buf), "chars": total, "strict": False}


async def _llm_check(
    context: str,
    answer: str,
    history: list[tuple[str, str]] | None = None,
) -> tuple[bool, str]:
    """LLM-as-judge 事实核查；失败时按通过处理，避免空转重生成。

    上一轮对话要一并给核查员：多轮追问的回答会引用前文已给出的结论（如先问
    曹操技能、再问装备牌，回答里顺带提到「上一轮提到的曹操」），只看本次检索
    片段会把这些判成「无依据」，于是触发无谓的重生成——用户就会看到答案先
    输出一次、又被替换成另一版。
    """
    prior = ""
    for role, content in (history or [])[-2:]:
        if role in ("user", "assistant") and content:
            prior += f"{'用户' if role == 'user' else '助手'}：{content[:400]}\n"
    prompt = [
        {
            "role": "system",
            "content": (
                "你是事实核查员。判断回答中的事实是否由「资料」或「上一轮对话」支持。"
                "与上一轮对话一致、或属于同一款桌游的常识性衔接内容，均算有依据。"
                '只输出 JSON：{"supported": true, "reason": "..."}。'
            ),
        },
        {
            "role": "user",
            "content": (
                (f"上一轮对话：\n{prior}\n\n" if prior else "")
                + f"资料：\n{context[:3000]}\n\n回答：\n{answer[:2000]}"
            ),
        },
    ]
    try:
        raw = await llm.chat_complete(
            prompt,
            temperature=0.0,
            max_tokens=600,
            model=settings.LLM_FAST_MODEL or settings.LLM_MODEL,
            enable_thinking=False,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("幻觉检查失败，按通过处理：%s", e)
        return True, ""
    obj = _parse_json(raw)
    return _as_bool(obj, "supported", True), str(obj.get("reason") or "")[:200]


async def _check(state: RAGState) -> dict:
    """生成后核查；不通过则清空上一版并重生成，到上限则追加提示。"""
    if not settings.AGENTIC_CHECK_ENABLED or state.get("fallback"):
        return {"check_passed": True}

    answer = state.get("answer") or ""
    if len(answer) < 20:
        return {"check_passed": True}

    ok, reason = await _llm_check(
        state.get("context") or "", answer, state.get("history")
    )
    if ok:
        return {"check_passed": True}

    log.info("规则问答事实核查未通过：%s", reason)
    attempts = int(state.get("check_attempts", 0)) + 1
    # 不重生成：首版已经边生成边流给用户了，再生成一版只能「清屏后重播」，
    # 用户看到的就是「先输出一个答案、又被另一个答案替换」。实测「先问曹操
    # 技能、再问装备牌」每次都会走这条：本站《三国杀》语料只有说明书 2 页，
    # 装备牌清单本来就无原文依据，重生成多少版都同样无依据。核查结果只记
    # 日志并随 done 回传 check_passed，供评测/排查用，正文保持干净。
    log.warning("事实核查未通过，保留首版正文，不再重生成")
    # 核查不通过说明这句话没有原文依据（模型自带知识 / 站外残留）。把依据标签
    # 改成 L4 措辞，避免正文写着「依据规则说明书」、内容却不在说明书里。
    _emit(
        "level",
        {
            "level": 4,
            "label": "模型知识补充（未经本站规则书核对）",
            "game": state.get("game_name"),
            "game_id": state.get("resolved_game_id"),
        },
    )
    return {
        "check_attempts": attempts,
        "check_passed": False,
        "answer": answer,
        "chars": len(answer),
    }


async def _fallback(state: RAGState) -> dict:
    """检索重试到上限：明确降级，清空引用并改标 L4。"""
    label = rule_qa.LEVEL_LABEL[4]
    _emit(
        "level",
        {
            "level": 4,
            "label": label,
            "game": state.get("game_name"),
            "game_id": state.get("resolved_game_id"),
            "fallback": True,
        },
    )
    _emit("citations", {"items": [], "count": 0})
    _emit("info", {"text": "检索到的依据不足，改用「明确未收录 + 建议」的回答"})
    return {
        "level": 4,
        "label": label,
        "fallback": True,
        "strict": False,
        "citations": [],
    }


def _after_grade(state: RAGState) -> str:
    grade = state.get("grade")
    if grade == "sufficient":
        return "generate"
    if grade == "exhausted":
        return "fallback"
    return "rewrite"


def _after_check(state: RAGState) -> str:
    if state.get("fallback") or state.get("check_passed"):
        return "end"
    if not state.get("answer") and int(state.get("check_attempts", 0)) < max(
        1, settings.AGENTIC_MAX_CHECK_RETRIES
    ):
        return "generate"
    return "end"


def _build_graph():
    graph = StateGraph(RAGState)
    graph.add_node("rewrite", _rewrite)
    graph.add_node("retrieve", _retrieve)
    graph.add_node("grade", _grade)
    graph.add_node("generate", _generate)
    graph.add_node("check", _check)
    graph.add_node("fallback", _fallback)

    graph.add_edge(START, "rewrite")
    graph.add_edge("rewrite", "retrieve")
    graph.add_edge("retrieve", "grade")
    graph.add_conditional_edges(
        "grade",
        _after_grade,
        {"generate": "generate", "rewrite": "rewrite", "fallback": "fallback"},
    )
    graph.add_edge("fallback", "generate")
    graph.add_edge("generate", "check")
    graph.add_conditional_edges(
        "check",
        _after_check,
        {"generate": "generate", "end": END},
    )
    return graph.compile()


_GRAPH = _build_graph()


async def run_agentic_stream(
    db: AsyncSession,
    message: str,
    *,
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    game_hint: str | None = None,
    dialogue_state: dict | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """跑一次状态图，产出与旧流水线一致的 (event, payload)。"""
    initial: RAGState = {
        "message": message,
        "history": history or [],
        "game_id": game_id,
        "game_hint": game_hint,
        "dialogue_state": dialogue_state or {},
        "query": message,
        "retrieval_attempts": 0,
        "check_attempts": 0,
        "strict": False,
        "fallback": False,
    }

    token = _db_ctx.set(db)
    final: dict = {}
    # 只有回答**开头**就在说「本站暂无 / 未收录」时才需要站外补一次，而这种自述
    # 一定出现在最初几十字内。因此只暂扣开头 HEAD_GATE 字做判定：
    #   · 开头就承认缺资料 → 继续暂扣，等站外结果，站内那段一个字都不显示；
    #   · 开头正常作答     → 立刻放行并恢复实时流式（后续即使结尾补一句保守说明，
    #                        也不会再触发替换）。
    # 旧实现有两种半吊子做法都踩过坑：攒 160 字才放行会把「先概述、结尾才承认
    # 未记载」的中间稿流给用户；全程暂扣又让所有回答都失去流式。
    HEAD_GATE = 80
    held: list[str] = []
    head_passed = False
    suppressed = False
    try:
        async for stream_mode, chunk in _GRAPH.astream(
            initial, stream_mode=["custom", "values"]
        ):
            if stream_mode == "custom":
                kind = chunk.get("type")
                if kind == "delta":
                    text = (chunk.get("text") or "").replace("**", "")
                    if not text:
                        continue
                    if suppressed:
                        held.append(text)
                        continue
                    if head_passed:
                        yield "delta", text
                        continue
                    held.append(text)
                    joined = "".join(held)
                    if _MISSING_PAT.search(joined) and not _OUT_OF_POOL_PAT.search(joined):
                        suppressed = True
                    elif len(joined) >= HEAD_GATE:
                        head_passed = True
                        for i in range(0, len(joined), 40):
                            yield "delta", joined[i : i + 40]
                        held.clear()
                elif kind in ("level", "citations", "info", "notice"):
                    yield kind, json.dumps(
                        chunk.get("payload") or {}, ensure_ascii=False
                    )
            elif stream_mode == "values":
                final = chunk
    finally:
        _db_ctx.reset(token)

    level = int(final.get("level", 4))
    answer = final.get("answer") or ""
    # 与上面的流式判定保持同一把尺子：只看开头 HEAD_GATE 字。
    # 放宽到 160 字会把「1. 村庄值1分…（说明书未明说具体分数）」这类先给出正确
    # 事实、再补一句保守说明的回答误判成缺失，白等联网还把答案替换掉。
    head = answer.lstrip()[:HEAD_GATE]
    missing_head = bool(
        answer and _MISSING_PAT.search(head) and not _OUT_OF_POOL_PAT.search(answer)
    )

    # 站内资料只覆盖一部分（回答开头自报「暂无/未收录」）→ 联网补一次缺失细节。
    # L4 也要补：曹操这类「游戏在池内、但该条目没收录」的提问经常落到 L4。
    external = False
    if level in (1, 2, 3, 4) and answer:
        log.info(
            "[external-gate] level=%s cites=%d len=%d head=%r",
            level,
            len(final.get("citations") or []),
            len(answer),
            answer[:120],
        )
    if level in (1, 2, 3, 4) and missing_head:
        yield "info", json.dumps(
            {"text": "站内资料未覆盖该细节，正在检索站外公开资料…"}, ensure_ascii=False
        )
        extra_prompt = [
            {"role": "system", "content": _EXTERNAL_SYSTEM_PROMPT},
        ]
        # 追问（「防具里面不是还有个藤甲吗」）单看本句会丢主题，带上最近两轮对话
        for role, content in (final.get("history") or [])[-4:]:
            if role in ("user", "assistant") and content:
                extra_prompt.append({"role": role, "content": content[:500]})
        extra_prompt.append(
            {
                "role": "user",
                "content": (
                    f"用户问题：{final.get('message') or ''}\n\n"
                    f"站内已收录的相关资料（仅作事实核对，不要复述）：\n"
                    f"{(final.get('context') or '')[:2000]}\n\n"
                    f"站内已有的回答（它承认这部分未收录，不要重复它的话）：\n{answer[:1500]}"
                ),
            }
        )
        # 站外结果同样要「边收边出」，否则用户要干等一次完整检索 + 生成。
        # 只暂扣开头 EXTRA_GATE 字：若开头就是「没找到 / 无可靠资料」，说明这轮
        # 站外补全失败，一个字都不放（改为回放站内回答）；否则立刻放行并实时流式。
        EXTRA_GATE = 60
        extra_buf: list[str] = []
        extra_streaming = False
        extra_dead = False
        try:
            async for kind, piece in llm.chat_stream(
                extra_prompt,
                temperature=0.2,
                max_tokens=rule_qa.MAX_TOKENS,
                model=settings.LLM_RULE_MODEL or settings.LLM_MODEL,
                enable_thinking=False,
                extra={"enable_search": True},
            ):
                if kind != "content" or not piece:
                    continue
                if extra_dead:
                    continue
                piece = piece.replace("**", "")
                extra_buf.append(piece)
                if extra_streaming:
                    yield "delta", piece
                    continue
                joined = "".join(extra_buf)
                if _EXTERNAL_MISS_PAT.search(joined):
                    extra_dead = True
                elif len(joined) >= EXTRA_GATE:
                    extra_streaming = True
                    # 标签先换成「站外补充」，让用户知道这段来源
                    yield "level", json.dumps(
                        {
                            "level": level,
                            "label": "站外检索补充（未经本站规则书核对）",
                            "game": final.get("game_name"),
                            "game_id": final.get("resolved_game_id"),
                        },
                        ensure_ascii=False,
                    )
                    for i in range(0, len(joined), 40):
                        yield "delta", joined[i : i + 40]
        except llm.LLMError as e:  # noqa: BLE001
            log.warning("站外资料检索失败：%s", e)

        extra_text = "".join(extra_buf).strip()
        # 站外也没查到时不能把「未找到」当答案顶掉站内回答
        if extra_text and not extra_dead and not _EXTERNAL_MISS_PAT.search(extra_text):
            external = True
            answer = extra_text
            if not extra_streaming:
                # 极短结果（不足 EXTRA_GATE）才会走到这里，补发一次
                yield "level", json.dumps(
                    {
                        "level": level,
                        "label": "站外检索补充（未经本站规则书核对）",
                        "game": final.get("game_name"),
                        "game_id": final.get("resolved_game_id"),
                    },
                    ensure_ascii=False,
                )
                for i in range(0, len(extra_text), 40):
                    yield "delta", extra_text[i : i + 40]
        else:
            # 站外没查到：把暂扣的站内回答补放出来，避免空答
            if not extra_streaming:
                for piece in held:
                    yield "delta", piece
                held.clear()
                yield "notice", json.dumps(
                    {"text": "站外公开资料也未找到可靠记载，以上为本站资料能确认的部分"},
                    ensure_ascii=False,
                )
    else:
        # 不含站外检索的回答（含「整款游戏不在候选池」的明确未收录）：原样放行
        for piece in held:
            yield "delta", piece
        held.clear()

    yield "done", json.dumps(
        {
            "level": level,
            "label": final.get("label") or rule_qa.LEVEL_LABEL.get(level, ""),
            "game": final.get("game_name"),
            "game_id": final.get("resolved_game_id"),
            "chars": len(answer),
            "answer": answer,
            "fallback": bool(final.get("fallback")),
            "check_passed": bool(final.get("check_passed", True)),
            "external": external,
            "citations": final.get("citations") or [],
        },
        ensure_ascii=False,
    )
