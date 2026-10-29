"""主 Agent 编排（Orchestrator）：把「意图分发」升级为 LLM 驱动的「真 Agent」。

为什么要从确定性 Router 再包一层：确定性 Router 只能二选一，一句话里同时含
「问规则 + 求推荐」的复合意图会被丢掉一半。Orchestrator 用一次 LLM 调用做派发决策，
让模型自己决定调 1 个还是 2 个副 Agent、以及怎么综合，补齐真 Agent 缺失的「控制流」。

设计要点（与既有工程的取舍一致）：
- 主 Agent：带 2 个 function-calling 工具的 LLM（invoke_rule_agent / invoke_recommend_agent）。
  直接复用 llm.chat_with_tools（已实现），不自己拼 tool-calling 请求。
- 副 Agent：**不重写**流水线，把 rule_qa.answer_stream / recommend.recommend_stream 的
  流式事件收集为完整结果；主 Agent 只看到 2 个业务级工具，不暴露裸 DB 工具（避免权限扩散）。
- 有界自主：最多 2 次工具调用 + 墙钟兜底（与 loop.WALL_CLOCK_SEC 同值）。
- 单意图：直接透传副 Agent 全部事件（保留 level/info/delta，UX 与改造前一致）。
- 复合意图：两份结果并行拿到后，由一次轻量合成调用合并；合成失败则退化拼接。
- 降级：主 Agent LLM 不可用 / 出错 → 由 loop.py 回落确定性 Router；永不空答。
"""
from __future__ import annotations

import asyncio
import ast
import json
import logging
import re
import time
from collections.abc import AsyncIterator

from app.agent import llm, rag, recommend, rule_qa
from app.core.config import settings

log = logging.getLogger(__name__)

# 有界自主：复合意图最多并行 2 个副 Agent；墙钟与 loop 保持一致
MAX_TOOL_CALLS = 2
ORCH_WALL_CLOCK_SEC = 90.0

TOOL_RULE = "invoke_rule_agent"
TOOL_REC = "invoke_recommend_agent"

ORCH_PROMPT = """你是 TableMind 桌游助手的「调度主编」。你**不直接回答**用户，只负责把任务派发给合适的专家副 Agent：

- invoke_rule_agent：当用户在问某款（某几款）具体桌游的「怎么运作」——规则、玩法、计分、费用、配件作用、胜负条件、回合流程、边界情况，或对着已点名的游戏问「怎么样/好不好玩/值不值得」时调用。
- invoke_recommend_agent：当用户在求推荐、找类似游戏、按人数/时长/类型/机制挑游戏时调用。

决策规则（务必遵守）：
1. 单意图（只问规则，或只求推荐）→ 只调用对应的那一个工具。
2. 复合意图（一句话里既问某款游戏怎么玩、又求推荐类似款，例如「卡坦岛怎么玩？再推荐几款类似的」）→ 两个工具都调用。
3. 完全无法判断（纯闲聊、打招呼、无主语的孤立短句）→ 两个工具都不调用，只在回复里友好地引导用户说明需求。
4. 你是调度者，**禁止自己编造任何桌游内容**（游戏名、规则、评分都来自副 Agent 的返回）。
5. 只做派发决策；复合意图的综合由你调用完工具后再写，不要在调用工具之前输出正文。"""


SYNTH_PROMPT = """你是 TableMind 的回答整合者。用户一句话里同时涉及「某款桌游的规则」和「推荐类似款」。

下面两份内容分别来自规则专家与推荐专家。请把它们整合成一段自然、连贯的回答：
- 先给规则解答，再给推荐，两类信息不要混在一起；
- 去除重复、避免自相矛盾，不要编造任何规则或游戏信息；
- 如果用户原问题其实只涉及其中一类，只保留相关部分，不要硬凑另一类。

纯文本输出，禁止 Markdown 语法。"""


def _chunk(text: str, size: int = 40) -> list[str]:
    """把整段文本切成小片，模拟流式输出（保持打字感）。"""
    if not text:
        return [""]
    return [text[i : i + size] for i in range(0, len(text), size)]


# 部分模型（或 function calling 偶发失败时）会把工具调用写成普通文本：
#   invoke_rule_agent({"query": "..."}) / invoke_rule_agent() / 只写一个工具名
# 若直接透传，前端就会展示这串内部指令。这里把它还原成结构化调用。
_TEXT_CALL_RE = re.compile(
    r"(invoke_rule_agent|invoke_recommend_agent)\s*\(\s*(\{.*?\})?\s*\)",
    re.S,
)
_BARE_CALL_RE = re.compile(r"^\s*(invoke_rule_agent|invoke_recommend_agent)\s*$")
_JSON_CALL_RE = re.compile(
    r"(invoke_rule_agent|invoke_recommend_agent)\s*(\{.*?\})", re.S
)


def _parse_args(raw: str) -> dict | None:
    """兼容 JSON 与 Python 字面量两种写法，失败返回 None。"""
    for loader in (json.loads, ast.literal_eval):
        try:
            value = loader(raw)
        except (ValueError, SyntaxError):
            continue
        if isinstance(value, dict):
            return value
    return None


def _recover_text_tool_calls(content: str) -> tuple[list[dict], str]:
    """从正文里捞回被写成文本的工具调用，并把这些片段从正文剔除。

    返回 (tool_calls, 清理后的正文)。解析不出来的伪调用只剔除、不执行，
    避免把残缺参数传给副 Agent。
    """
    if not content or "invoke_" not in content:
        return [], content

    calls: list[dict] = []

    def _add(name: str, raw_args: str | None) -> None:
        args = _parse_args(raw_args) if raw_args else {}
        if args is None:
            return
        calls.append({"id": "", "name": name, "arguments": args})

    # 1) 标准文本形态：name({...}) / name()
    for match in _TEXT_CALL_RE.finditer(content):
        _add(match.group(1), match.group(2))

    cleaned = _TEXT_CALL_RE.sub("", content)

    # 2) 省略括号：name {"query": ...}
    for match in _JSON_CALL_RE.finditer(cleaned):
        _add(match.group(1), match.group(2))
    cleaned = _JSON_CALL_RE.sub("", cleaned)

    # 3) 只输出了工具名（模型提前截断）：用原始问题作为参数
    bare = _BARE_CALL_RE.match(cleaned)
    if bare:
        _add(bare.group(1), None)
        cleaned = ""

    cleaned = re.sub(r"```(?:json)?", "", cleaned).strip()
    if calls:
        log.warning("主 Agent 以文本形式返回工具调用，已恢复：%s", [c["name"] for c in calls])
    return calls, cleaned


def _tool_specs() -> list[dict]:
    """主 Agent 可见的 2 个业务级工具（仅此而已，不暴露裸 DB 工具）。"""
    return [
        {
            "type": "function",
            "function": {
                "name": TOOL_RULE,
                "description": (
                    "桌游规则问答专家：回答某款（某几款）具体桌游的规则、玩法、计分、配件作用、"
                    "胜负条件、回合流程、边界情况，或对着已点名的游戏问「怎么样/好不好玩」。当用户问题属于规则类时调用。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "原样传给规则专家的用户问题（保留游戏名与问法，不要改写）",
                        }
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": TOOL_REC,
                "description": (
                    "桌游推荐专家：按人数/时长/类型/机制为用户挑选合适的桌游，或找某一款的类似游戏。"
                    "当用户在求推荐、找类似款时调用。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "原样传给推荐专家的用户问题（保留人数/时长/类型/参照游戏等条件）",
                        }
                    },
                    "required": ["query"],
                },
            },
        },
    ]


async def _collect_rule(
    db, query, *, user_id, history, game_id, dialogue_state=None
) -> list[tuple[str, str]]:
    """把规则副 Agent 的流式事件完整收集（保留 level/info/delta，便于单意图透传）。"""
    events: list[tuple[str, str]] = []
    try:
        async for event, payload in rule_qa.answer_stream(
            db, query, history=history, game_id=game_id,
            dialogue_state=dialogue_state,
        ):
            events.append((event, payload))
    except Exception as e:  # noqa: BLE001 - 副 Agent 失败不得拖垮主 Agent
        log.warning("规则副 Agent 执行失败：%s", e)
    return events


async def _collect_recommend(db, query, *, user_id, history, game_id) -> list[tuple[str, str]]:
    """把推荐副 Agent 的流式事件完整收集。"""
    events: list[tuple[str, str]] = []
    try:
        async for event, payload in recommend.recommend_stream(
            db, query, user_id=user_id, history=history
        ):
            events.append((event, payload))
    except Exception as e:  # noqa: BLE001
        log.warning("推荐副 Agent 执行失败：%s", e)
    return events


def _delta_text(events: list[tuple[str, str]]) -> str:
    """从收集到的事件里拼出副 Agent 的正文（只取 delta）。"""
    return "".join(p for ev, p in events if ev == "delta").strip()


async def run_orchestrator_stream(
    db,
    message: str,
    *,
    user_id: int | None = None,
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    trace_id: str | None = None,
    dialogue_state: dict | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """LLM 主 Agent 派发：决定调 1 个或 2 个副 Agent，必要时综合后流式返回。

    产出事件：route（编排决策）/ tool（状态）/ delta（最终正文）。
    任何 LLM 失败都抛异常，由 loop.py 回落确定性 Router。
    """
    trace = trace_id or "orch"
    t0 = time.monotonic()

    messages: list[dict] = [{"role": "system", "content": ORCH_PROMPT}]
    for role, content in (history or [])[-4:]:
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:400]})

    # 站内实体归一：主 Agent 认不出「伯明翰」「阿瓦隆」这类常用简称/副标题，
    # 会把规则问题当成站外或历史类话题直接澄清掉（实测「伯明翰运河时代什么时候结束」
    # 被回成「无法提供历史类信息」）。这里复用与副 Agent 相同的别名匹配先做归一，
    # 命中就显式告知主 Agent——否则它连「这是不是一款站内桌游」都不知道。
    matched = await rag.identify_games(db, message[:800])
    if not matched:
        # 追问句本身不含游戏名（「那如果没人有 8 张手牌呢」），回看最近一轮用户提问
        for role, content in reversed((history or [])[-4:]):
            if role == "user" and content:
                matched = await rag.identify_games(db, content[:800])
                if matched:
                    break
    if matched:
        names = "、".join(f"《{g.name}》" for g in matched[:3])
        messages.append(
            {
                "role": "system",
                "content": (
                    f"【站内实体识别】用户本轮涉及站内桌游：{names}。"
                    f"若在问规则/玩法/评价，直接调用 {TOOL_RULE}，"
                    "不要当成站外或非桌游话题；只有明确在求推荐时才调用推荐工具。"
                ),
            }
        )

    messages.append({"role": "user", "content": message[:800]})

    # 1) 主 Agent 决策（带 2 个工具）
    try:
        resp = await asyncio.wait_for(
            llm.chat_with_tools(
                messages,
                _tool_specs(),
                temperature=0.0,
                max_tokens=800,
                model=settings.LLM_MODEL,  # 需支持 function calling（真流式依赖主 Agent 派发）
                enable_thinking=False,
            ),
            ORCH_WALL_CLOCK_SEC,
        )
    except (llm.LLMError, asyncio.TimeoutError) as e:
        log.warning("[trace=%s] Orchestrator LLM 调用失败/超时：%s", trace, e)
        raise  # 交给 loop.py 回落确定性 Router

    tool_calls = resp.get("tool_calls") or []
    content = resp.get("content") or ""

    # 模型偶尔把工具调用写成正文（无结构化 tool_calls）：先尝试还原，
    # 避免把 invoke_rule_agent({...}) 这种内部指令直接展示给用户。
    if not tool_calls:
        tool_calls, content = _recover_text_tool_calls(content)

    # 2) 无工具调用 → 澄清/闲聊引导（不编造）
    if not tool_calls:
        direct = content or (
            "我不太确定你想问的是「某款桌游的具体规则」还是「想让我推荐桌游」。\n"
            "你可以这样问：\n"
            "1. 问规则：璀璨宝石里拿宝石有什么限制？\n"
            "2. 求推荐：推荐 3 款 4 人能玩、一小时内结束的合作类游戏"
        )
        yield "route", json.dumps(
            {"intent": "orchestrator-clarify", "via": "orchestrator"}, ensure_ascii=False
        )
        for piece in _chunk(direct):
            yield "delta", piece
        return

    # 3) 归一化工具调用：去重 + 限制数量 + 过滤非法名
    calls: list[tuple[str, dict]] = []
    seen: set[str] = set()
    for tc in tool_calls:
        name = tc.get("name")
        if name in seen or name not in (TOOL_RULE, TOOL_REC):
            continue
        seen.add(name)
        calls.append((name, tc.get("arguments", {}) or {}))
        if len(calls) >= MAX_TOOL_CALLS:
            break

    yield "route", json.dumps(
        {"intent": "orchestrator", "via": "orchestrator", "tools": [c[0] for c in calls]},
        ensure_ascii=False,
    )
    # 用 info 而非 tool：前端 info 直接展示文本，tool 需要匹配 TOOL_LABEL 才会显示具体文案
    yield "info", json.dumps(
        {"text": "主 Agent 正在调度专家副 Agent 作答…"}, ensure_ascii=False
    )
    # 立刻告诉前端「正在思考」，让它开始实时计时；
    # 之前只有副 Agent 内部才发 thinking，单意图被整体缓冲后用户在这几秒里看不到任何计时。
    yield "thinking", "正在思考…"

    # 4a) 单意图：直接流式透传副 Agent 事件（真流式，首字延迟 = 生成首 token）
    if len(calls) == 1:
        name, args = calls[0]
        q = str(args.get("query") or message)
        # 模型偶尔把「上一轮问题」当成这一轮的 query（追问就会拿到上一轮的缓存答案），
        # 这里留一条日志便于排查；命中历史原句时以本轮原话为准。
        prev_user = [c for r, c in (history or []) if r == "user"]
        if prev_user and q.strip() == prev_user[-1].strip() and message.strip() != q.strip():
            log.warning("[trace=%s] 主 Agent query 复述了上一轮问题，已改用本轮原话", trace)
            q = message
        log.info("[trace=%s] 调度 → %s | query=%s", trace, name, q[:80])
        stream = (
            rule_qa.answer_stream(
                db, q, history=history, game_id=game_id, dialogue_state=dialogue_state
            )
            if name == TOOL_RULE
            else recommend.recommend_stream(
                db, q, user_id=user_id, history=history, source_message=message
            )
        )
        emitted = False
        try:
            async for event, payload in stream:
                if event == "delta":
                    emitted = True
                yield event, payload
        except Exception as e:  # noqa: BLE001
            log.warning("[trace=%s] 单意图副 Agent 流式失败：%s", trace, e)
            if emitted:
                # 已经吐出部分内容：不能再让上层回落重答，否则会出现两段回答
                yield "notice", json.dumps(
                    {"text": "回答生成中断，请重试"}, ensure_ascii=False
                )
                return
            raise
        return

    # 4b) 复合意图：并行执行副 Agent（两条流必须都拿到才能合成）
    async def _dispatch(name: str, args: dict) -> tuple[str, list[tuple[str, str]]]:
        q = args.get("query", message)
        if name == TOOL_RULE:
            return name, await _collect_rule(
                db, q, user_id=user_id, history=history, game_id=game_id,
                dialogue_state=dialogue_state,
            )
        return name, await _collect_recommend(
            db, q, user_id=user_id, history=history, game_id=game_id
        )

    try:
        results_raw = await asyncio.wait_for(
            asyncio.gather(
                *[_dispatch(n, a) for n, a in calls], return_exceptions=True
            ),
            ORCH_WALL_CLOCK_SEC,
        )
    except asyncio.TimeoutError:
        log.warning("[trace=%s] 副 Agent 执行超时", trace)
        raise RuntimeError("副 Agent 执行超时") from None

    results: dict[str, list[tuple[str, str]]] = {}
    for r in results_raw:
        if isinstance(r, Exception):
            log.warning("[trace=%s] 副 Agent 异常：%s", trace, r)
            continue
        name, evts = r
        results[name] = evts

    if not results:
        raise RuntimeError("所有副 Agent 均无输出")

    # 5a) 单意图：直接透传副 Agent 的全部事件（保留 level/info/delta，UX 与升级前一致）
    if len(results) == 1:
        only = next(iter(results.values()))
        log.info("[trace=%s] 单意图透传副 Agent", trace)
        for event, payload in only:
            yield event, payload
        return

    # 5b) 复合意图：综合两份结果
    rule_text = _delta_text(results.get(TOOL_RULE, []))
    rec_text = _delta_text(results.get(TOOL_REC, []))
    if not rule_text or not rec_text:
        # 其中一个失败 → 退化：只透传还有的那份（即便没有原始事件，也至少给纯文本）
        surviving = rule_text or rec_text
        log.warning("[trace=%s] 复合意图有一侧为空，退化单份输出", trace)
        # 规则侧存活时，引用片段仍要带给前端
        for event, payload in results.get(TOOL_RULE, []):
            if event in ("level", "citations"):
                yield event, payload
        for piece in _chunk(surviving):
            yield "delta", piece
        return

    synth_prompt = [
        {"role": "system", "content": SYNTH_PROMPT},
        {
            "role": "user",
            "content": (
                f"【用户原问题】{message}\n\n"
                f"【规则专家回答】\n{rule_text}\n\n"
                f"【推荐专家回答】\n{rec_text}"
            ),
        },
    ]
    try:
        synth = await asyncio.wait_for(
            llm.chat_complete(
                synth_prompt,
                temperature=0.3,
                max_tokens=2000,
                model=settings.LLM_MODEL,
                enable_thinking=False,
            ),
            ORCH_WALL_CLOCK_SEC,
        )
    except (llm.LLMError, asyncio.TimeoutError) as e:
        log.warning("[trace=%s] 复合意图合成失败，退化拼接：%s", trace, e)
        synth = "【规则解答】\n" + rule_text + "\n\n【相似推荐】\n" + rec_text

    log.info("[trace=%s] 复合意图综合完成，用时 %.2fs", trace, time.monotonic() - t0)
    # 合成答案的规则部分仍来自规则副 Agent，保留其依据层级与引用片段
    for event, payload in results.get(TOOL_RULE, []):
        if event in ("level", "citations"):
            yield event, payload
    for piece in _chunk(synth):
        yield "delta", piece
