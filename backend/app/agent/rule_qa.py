"""规则问答流水线：分层检索（L1→L4）+ 带引用层级的生成。

分层的目的只有一个：**不让 AI 瞎编规则**。每一层都有明确的依据来源，
回答里必须标注来自哪一层；落到 L4（模型推测）时必须明说「未验证」。

- L1 结构化资料：board_games 的真实字段（人数/时长/分类/机制/简介）。能答概况，答不了规则细节。
- L2 规则书原文：rule_documents 的语义切片（向量 Top-K，无 embedding 时关键词降级）。**权威来源**。
- L3 BGG 社区共识：当前**默认关闭**——实测 boardgamegeek.com/xmlapi2 返回 401（已强制鉴权），
  拿不到数据就不许编。恢复条件：拿到可用鉴权后把 settings.RULE_BGG_LAYER_ENABLED 打开并实现抓取。
- L4 模型推测：上面都没命中时的兜底，回答必须标注「未验证」。

生成用 LangChain 的 LCEL 链（prompt | model | parser）流式输出。
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

from app.agent import rag
from app.agent import tools as db_tools
from app.agent import answer_cache
from app.agent import llm
from app.agent import pool as pool_mod
from app.agent import dialogue_state as dialogue_state_mod
from app.core.config import settings

log = logging.getLogger(__name__)

# 分层标签：前端可直接展示，回答里也会要求模型体现
LEVEL_LABEL = {
    1: "依据本站结构化资料",
    2: "依据规则说明书",
    3: "依据 BGG 社区共识",
    4: "本站未收录该规则（无原文依据）",
}

TOP_K = 5
GEN_TIMEOUT_SEC = 60.0

# 统一输出：不按模式区分预算，提示词里也不限制字数。
# 上限仅作为接口侧兜底，防止异常长输出打爆连接。
MAX_TOKENS = rag.ANSWER_MAX_TOKENS

# 刻意保持精简：提示词越长越容易分散注意力。约束条目能省则省，只留会影响事实正确性的。
SYSTEM_PROMPT = """你是 TableMind 的规则裁判，只依据「资料」回答桌游规则问题。

1. 只能用资料里的事实作答；资料没写的细节就说「本站暂无该信息」，禁止推测或编造。
   资料里根本没出现用户问的对象（某个牌名、角色名、机制、阶段名）时，一律按「资料未覆盖」处理，
   不能因为「资料里没写」就断言该规则不存在、更不能凭常识补全它的数值或效果。
2. 若依据层级是「本站未收录」，只用一句话说明本站尚未收录这条规则，
   不要给建议清单、不要解释检索过程、不要复述候选池名单——系统会在回答后自动联网补充。
3. 涉及数字（费用、分数、数量）必须与资料完全一致，讲解用「1. 2. 3.」分点。
4. 判断「在不在本站候选池」要先核对名单：只有名单里确实没有用户所问的游戏（包括问题里卡牌/术语所属的游戏）时，才可以说不在本站候选池；若在名单内但本站没有该问题的规则资料，就说「《X》本站尚未收录这条规则」，按第 2 条一句话作答。
5. 中文作答，纯文本，禁止任何 Markdown 语法（包括 ** 加粗、- 列表）。
6. 按问题本身的需要作答，不限制字数：资料足够就讲透，资料不足就直说缺什么。
7. 只输出最终答案：不要把补充说明写成「注：」这类脚注，必要信息直接并入正文分点。
8. 不要提及内部检索编号或出处（如「片段1」「资料第2条」「根据提供的资料」），直接给结论；
   也不要写「资料/说明书没有字面写」「以上资料显示」这类交代检索过程的句子——确定就直说，不确定才算未收录。
   禁止出现「资料」「说明书」「候选池」「本站已收录/未收录（某角色/某牌）」这类元描述：
   用户问角色就列角色，问牌就列牌；某对象不在资料里时，最多一句「X 本站暂无该信息」，
   不许展开成「资料里只列出了 A、B、C，没有提到 D、E、F，因此……」这种论证。

依据层级：{level_label}"""


def _chunk(text: str, size: int = 40) -> list[str]:
    """把整段缓存答案切成小片，模拟流式输出（秒回但仍有打字感）。"""
    if not text:
        return [""]
    return [text[i : i + size] for i in range(0, len(text), size)]


async def _bgg_layer(game_name: str, query: str) -> list[str] | None:
    """L3：BGG 社区共识。当前不可用（401 强制鉴权），故恒返回 None 且不编造。"""
    if not getattr(settings, "RULE_BGG_LAYER_ENABLED", False):
        return None
    # 启用后应在此抓取 BGG 社区问答；未实现前不允许返回任何内容。
    log.info("L3 BGG 层已启用但未实现抓取（game=%s）", game_name)
    return None


async def _resolve_game(db, message, game_id, game_hint, history, dialogue_state=None):
    """定位主题游戏：显式 id > hint/正文识别 > 对话状态话题 > 从历史追问里带回上一轮主题。

    返回 (game, 来源)；来源 ∈ {id, text, state, history, none}。
    解决的问题：追问「有没有详细教程」「那掷出 7 但没资源呢」里没有游戏名，
    必须从对话状态或上一轮带回主题游戏（卡坦岛）。
    """
    from app.models.board_game import BoardGame

    if game_id is not None:
        g = await db.get(BoardGame, game_id)
        if g is not None:
            return g, "id"
    g = await rag.identify_game(db, game_hint or message)
    if g is not None:
        return g, "text"
    # 对话状态里的话题游戏：直接用 id 取，比逐条扫历史更可靠
    if dialogue_state and dialogue_state.get("topic_game_id"):
        g = await db.get(BoardGame, int(dialogue_state["topic_game_id"]))
        if g is not None:
            return g, "state"
    for role, content in reversed(history or []):
        if role == "user" and content and content.strip():
            g = await rag.identify_game(db, content)
            if g is not None:
                return g, "history"
    return None, "none"


async def retrieve_layered_with_citations(
    db,
    message: str,
    *,
    query: str | None = None,
    game_id: int | None = None,
    game_hint: str | None = None,
    history: list[tuple[str, str]] | None = None,
    dialogue_state: dict | None = None,
) -> tuple[int, str, object | None, list[dict]]:
    """按 L1→L4 顺序检索，额外返回可用于引用溯源的片段列表。

    query 是检索查询（可由状态图的 rewrite 节点改写）；message 仍用于定位游戏，
    保证换问法重试时不会把主题游戏换掉。
    """
    # 定位游戏：显式 game_id 优先，其次提问文本，再次对话状态话题，最后从历史里找
    game, src = await _resolve_game(db, message, game_id, game_hint, history, dialogue_state)

    q = (query or message or "").strip() or message
    # 追问且当前句未点名游戏时，补上主题词与实体上下文，帮助查询改写与检索命中。
    if game is not None and src in ("state", "history") and game.name not in q:
        if src == "state":
            q = dialogue_state_mod.build_retrieval_query(q, game.name, dialogue_state)
        else:
            q = f"{game.name} {q}"

    # L2：规则说明书原文（权威）
    if game is not None:
        hits = await rag.retrieve_rule_chunk_hits(db, game.id, q, k=TOP_K)
        chunks = [text for _idx, text in hits if (text or "").strip()]
        if chunks:
            # 不编号：模型会照着编号引用「片段N」，把内部检索细节漏给用户
            body = "\n\n".join(chunks)
            ctx = (
                f"《{game.name}》的规则说明书原文（共 {len(chunks)} 段，按相关度排序）：\n\n{body}"
            )
            citations = [
                {
                    "source": "规则说明书",
                    "game": game.name,
                    "game_id": game.id,
                    "chunk_index": int(idx),
                    "text": (text or "").strip()[:240],
                }
                for idx, text in hits
                if (text or "").strip()
            ]
            return 2, ctx, game, citations

    # L3：BGG 社区共识（当前恒不可用）
    bgg = await _bgg_layer(game.name if game else (game_hint or ""), message)
    if bgg:
        citations = [
            {
                "source": "BGG 社区共识",
                "game": game.name if game else None,
                "game_id": game.id if game else None,
                "chunk_index": None,
                "text": text[:240],
            }
            for text in bgg
        ]
        return 3, "\n\n".join(bgg), game, citations

    # L1：结构化资料（能答概况）
    if game is not None:
        detail = await db_tools.get_game_detail(db, game.id)
        if detail:
            ctx = f"《{game.name}》的本站结构化资料：\n{json.dumps(detail, ensure_ascii=False, indent=1)}"
            citations = [
                {
                    "source": "本站结构化资料",
                    "game": game.name,
                    "game_id": game.id,
                    "chunk_index": None,
                    "text": ctx[:240],
                }
            ]
            return 1, ctx, game, citations

    # L4：没有任何依据
    stats = await pool_mod.pool_stats(db)
    ctx = (
        "（本站未收录与这个问题相关的规则资料，也没有识别到提问中提到的游戏。"
        f"本站候选池共 {stats['total']} 款桌游，其中 {stats['with_rules']} 款已收录规则说明书。"
        "若用户提到的游戏不在候选池名单内，请明确说明它不在本站候选池，不要说成搜索失败。）"
    )
    return 4, ctx, game, []


async def retrieve_layered(
    db,
    message: str,
    game_id: int | None = None,
    game_hint: str | None = None,
    history: list[tuple[str, str]] | None = None,
    dialogue_state: dict | None = None,
) -> tuple[int, str, object | None]:
    """兼容旧调用：返回 (层级, 资料文本, 游戏对象)，丢弃引用片段。"""
    level, ctx, game, _citations = await retrieve_layered_with_citations(
        db,
        message,
        game_id=game_id,
        game_hint=game_hint,
        history=history,
        dialogue_state=dialogue_state,
    )
    return level, ctx, game


async def build_generation_messages(
    db,
    message: str,
    history: list[tuple[str, str]] | None,
    context: str,
    label: str,
    *,
    strict: bool = False,
    fallback: bool = False,
) -> list[dict]:
    """构造生成用的完整消息列表（状态图与旧流水线共用）。"""
    prompt_msgs = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT.format(level_label=label),
        },
    ]
    # 事实核查不通过后的重生成：要求逐句对照资料，删掉无依据内容
    if strict:
        prompt_msgs.append(
            {
                "role": "system",
                "content": (
                    "上一版回答中有未被资料支持的内容。请逐句对照资料重写，删除所有资料未写明的结论；"
                    "无法确认的细节直接说「本站暂无该信息」，不要用常识补全。"
                    "只输出结论，不要写论证过程，也不要提「资料」「说明书」「上下文」这些词。"
                ),
            }
        )
    # 检索重试到上限仍不足：一句话声明未收录，绝不编规则、绝不给建议清单
    if fallback:
        prompt_msgs.append(
            {
                "role": "system",
                "content": (
                    "本次没有检索到该问题的站内资料。回答只做一件事：用一句话说明"
                    "「本站暂未收录这条规则」。禁止推测具体数字、费用、步骤或结算方式；"
                    "不要给建议清单、不要罗列候选池、不要解释检索过程。"
                ),
            }
        )
    # 带上最近一轮对话，帮助省略主语的追问（如「有没有详细教程」）延续上下文
    for role, content in (history or [])[-2:]:
        if role in ("user", "assistant") and content:
            prompt_msgs.append({"role": role, "content": content[:500]})
    # 候选池名单：供模型判断「这款在不在站内收录范围」，避免把池内游戏说成未收录
    roster = await pool_mod.pool_roster_text(db)
    prompt_msgs.append(
        {
            "role": "user",
            "content": (
                f"资料：\n{context}\n\n"
                f"本站候选池名单（仅用于判断某款游戏在不在站内收录范围，不得据此编造规则）：{roster}\n\n"
                f"问题：{message}"
            ),
        }
    )
    return prompt_msgs


async def _legacy_answer_stream(
    db,
    message: str,
    *,
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    game_hint: str | None = None,
    dialogue_state: dict | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """旧的固定流水线：分层检索 → 生成。状态图在产出事件前失败时作为兜底。"""
    level, context, game, citations = await retrieve_layered_with_citations(
        db,
        message,
        game_id=game_id,
        game_hint=game_hint,
        history=history,
        dialogue_state=dialogue_state,
    )
    label = LEVEL_LABEL.get(level, "")
    yield "level", json.dumps(
        {
            "level": level,
            "label": label,
            "game": game.name if game else None,
            "game_id": game.id if game else None,
        },
        ensure_ascii=False,
    )
    if citations:
        yield "citations", json.dumps(
            {"items": citations, "count": len(citations)}, ensure_ascii=False
        )

    prompt_msgs = await build_generation_messages(
        db, message, history, context, label
    )

    total = 0
    buf: list[str] = []
    try:
        async for kind, piece in llm.chat_stream(
            prompt_msgs,
            temperature=0.3,
            max_tokens=MAX_TOKENS,
            model=settings.LLM_RULE_MODEL or settings.LLM_MODEL,
            enable_thinking=settings.LLM_RULE_THINKING,
        ):
            if kind == "content" and piece:
                total += len(piece)
                buf.append(piece)
                yield "delta", piece
            # reasoning 片段不展示（enable_thinking=False 时本就不产生）
    except llm.LLMError as e:  # noqa: BLE001
        log.warning("规则问答生成失败：%s", e)
        raise

    # 正文为空通常是推理模型把 token 全花在思维链上了。
    # 与其返回一句「抱歉」，不如抛出去让上层回落到已验证可用的 RAG 工作流。
    if total == 0:
        raise RuntimeError(
            "规则问答未生成任何正文（疑似推理模型思维链耗尽 token 预算）"
        )

    yield "done", json.dumps({"level": level, "label": label, "chars": total}, ensure_ascii=False)

    # 写回缓存（仅依据明确的层级，绝不缓存 L4 未验证）
    if level in (1, 2, 3):
        await answer_cache.put(
            game.id if game else None, message, "".join(buf), level,
            settings.LLM_RULE_MODEL or settings.LLM_MODEL,
            game_name=game.name if game else None,
            citations=citations,
        )


async def answer_stream(
    db,
    message: str,
    *,
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    game_hint: str | None = None,
    dialogue_state: dict | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """跑一次规则问答，产出 (event, payload)：level → citations? → delta* → done。

    先查热点答案缓存，命中则秒回；未命中时优先走 LangGraph Agentic RAG 状态图。
    状态图在产出任何事件前失败则回落旧流水线，保证「永不空答」。
    """
    # 主题游戏（含对话状态/历史追问）—— 同时用于缓存 key，避免追问串到其它游戏
    topic_game, _src = await _resolve_game(db, message, game_id, game_hint, history, dialogue_state)
    cache_game_id = topic_game.id if topic_game else None

    # 1) 热点缓存：命中直接秒回，绕开「改写 LLM + 生成 LLM」长链路。
    # 只对**首轮提问**生效：多轮追问依赖上文，缓存按单句 embedding 近似匹配
    # 会串味——实测「抵抗组织阿瓦隆怎么玩」答完后追问「间谍认出梅林不是也算
    # 间谍获胜吗」，被 0.99 相似度判成同一问题，原样回了上一轮的「怎么玩」。
    if settings.ANSWER_CACHE_ENABLED and not history:
        hit = await answer_cache.get(cache_game_id, message)
        if hit:
            label = LEVEL_LABEL.get(hit["level"], "")
            yield "level", json.dumps(
                {
                    "level": hit["level"],
                    "label": label,
                    "game": hit.get("game_name"),
                    "game_id": cache_game_id,
                    "cached": True,
                },
                ensure_ascii=False,
            )
            tag = "精确" if hit["hit"] == "exact" else f"近似 {hit.get('sim')}"
            yield "info", json.dumps(
                {"text": f"（命中高频问题缓存，已秒回 · {tag}）"}, ensure_ascii=False
            )
            cached_citations = hit.get("citations") or []
            if cached_citations:
                yield "citations", json.dumps(
                    {"items": cached_citations, "count": len(cached_citations)},
                    ensure_ascii=False,
                )
            for piece in _chunk(hit["text"]):
                yield "delta", piece
            yield "done", json.dumps(
                {"level": hit["level"], "label": label, "chars": len(hit["text"]), "cached": True},
                ensure_ascii=False,
            )
            return

    # 2) 优先走 Agentic RAG 状态图
    if settings.AGENTIC_RAG_ENABLED:
        emitted = False
        done_payload: dict | None = None
        try:
            from app.agent import agentic_rag

            async for event, payload in agentic_rag.run_agentic_stream(
                db,
                message,
                history=history,
                game_id=game_id,
                game_hint=game_hint,
                dialogue_state=dialogue_state,
            ):
                emitted = True
                if event == "done":
                    try:
                        done_payload = json.loads(payload)
                    except ValueError:
                        done_payload = None
                yield event, payload
        except Exception as e:  # noqa: BLE001
            # 已经吐出 level/delta 后再回落会造成重复输出，交给上层处理
            if emitted:
                raise
            log.warning("Agentic RAG 执行失败，回落旧规则问答路径：%s", e)
        else:
            if (
                done_payload
                and done_payload.get("level") in (1, 2, 3)
                and done_payload.get("check_passed", True)
                and not done_payload.get("external")
                and done_payload.get("answer")
            ):
                await answer_cache.put(
                    done_payload.get("game_id") or cache_game_id,
                    message,
                    done_payload["answer"],
                    done_payload["level"],
                    settings.LLM_RULE_MODEL or settings.LLM_MODEL,
                    game_name=done_payload.get("game_name"),
                    citations=done_payload.get("citations"),
                )
            return

    # 3) 旧流水线兜底
    async for event, payload in _legacy_answer_stream(
        db,
        message,
        history=history,
        game_id=game_id,
        game_hint=game_hint,
        dialogue_state=dialogue_state,
    ):
        yield event, payload
