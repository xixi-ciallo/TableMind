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
from app.core.config import settings

log = logging.getLogger(__name__)

# 分层标签：前端可直接展示，回答里也会要求模型体现
LEVEL_LABEL = {
    1: "依据本站结构化资料",
    2: "依据规则说明书",
    3: "依据 BGG 社区共识",
    4: "未验证（模型推测，本站无原文依据）",
}

TOP_K = 5
GEN_TIMEOUT_SEC = 60.0

# 该模型是推理模型：思维链（reasoning_content）与正文共用 max_tokens。
# 实测（上下文 3411 字）：1600/2800 全部被思维链吃光、正文 0 字；给到 4000+ 正文才正常产出。
# 故这里给足预算，并保留「正文为空则抛错让上层降级」的兜底。
MAX_TOKENS_BY_MODE = {"fast": 4000, "deep": 5000}

# 刻意保持精简：该模型是推理模型，提示词越长思维链越长，会先吃掉正文的 token 预算。
# 实测同一上下文下，6 条详尽约束的提示词把输出全耗在思维链上（正文 0 字），
# 精简到 4 条后正文正常产出。约束条目能省则省。
SYSTEM_PROMPT = """你是 TableMind 的规则裁判，只依据「资料」回答桌游规则问题。

1. 只能用资料里的事实作答；资料没写的细节就说「本站暂无该信息」，禁止推测或编造。
2. 若依据层级是「未验证」，必须在开头说明这是推测、未经本站规则书验证。
3. 涉及数字（费用、分数、数量）必须与资料完全一致，讲解用「1. 2. 3.」分点。
4. 若问题里的游戏不在「本站候选池名单」内，明确说明它不在本站候选池（不要说"搜索失败"）。
5. 中文作答，纯文本，禁止 Markdown 语法。

依据层级：{level_label}｜回答模式：{mode_desc}"""


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


async def _resolve_game(db, message, game_id, game_hint, history):
    """定位主题游戏：显式 id > hint/正文识别 > 从历史追问里带回上一轮主题。

    返回 (game, 来源)；来源 ∈ {id, text, history, none}。
    解决的问题：追问「有没有详细教程」里没有游戏名，必须从上一轮带回「七大奇迹」。
    """
    from app.models.board_game import BoardGame

    if game_id is not None:
        g = await db.get(BoardGame, game_id)
        if g is not None:
            return g, "id"
    g = await rag.identify_game(db, game_hint or message)
    if g is not None:
        return g, "text"
    for role, content in reversed(history or []):
        if role == "user" and content and content.strip():
            g = await rag.identify_game(db, content)
            if g is not None:
                return g, "history"
    return None, "none"


async def retrieve_layered(
    db,
    message: str,
    game_id: int | None = None,
    game_hint: str | None = None,
    history: list[tuple[str, str]] | None = None,
) -> tuple[int, str, object | None]:
    """按 L1→L4 顺序检索，返回 (层级, 拼接好的资料文本, 命中的游戏对象)。

    只要 L2 规则书切片命中就用 L2（它比结构化资料更贴近「规则细节」这个诉求）。
    追问（「有没有详细教程」）里没有游戏名，会从 history 里带回上一轮主题游戏。
    """
    # 定位游戏：显式 game_id 优先，其次提问文本，最后从历史里找上一轮主题
    game, src = await _resolve_game(db, message, game_id, game_hint, history)

    # L2：规则说明书原文（权威）
    if game is not None:
        # 追问且当前句未点名游戏时，补上主题词，帮助查询改写与检索命中
        q = message
        if src == "history" and game.name not in message:
            q = f"{game.name} {message}"
        chunks = await rag.retrieve_rule_chunks(db, game.id, q, k=TOP_K)
        if chunks:
            body = "\n\n".join(f"片段{i + 1}：{c}" for i, c in enumerate(chunks))
            ctx = (
                f"《{game.name}》的规则说明书原文片段（共 {len(chunks)} 段）：\n\n{body}"
            )
            return 2, ctx, game

    # L3：BGG 社区共识（当前恒不可用）
    bgg = await _bgg_layer(game.name if game else (game_hint or ""), message)
    if bgg:
        return 3, "\n\n".join(bgg), game

    # L1：结构化资料（能答概况）
    if game is not None:
        detail = await db_tools.get_game_detail(db, game.id)
        if detail:
            ctx = f"《{game.name}》的本站结构化资料：\n{json.dumps(detail, ensure_ascii=False, indent=1)}"
            return 1, ctx, game

    # L4：没有任何依据
    stats = await pool_mod.pool_stats(db)
    ctx = (
        "（本站未收录与这个问题相关的规则资料，也没有识别到提问中提到的游戏。"
        f"本站候选池共 {stats['total']} 款桌游，其中 {stats['with_rules']} 款已收录规则说明书。"
        "若用户提到的游戏不在候选池名单内，请明确说明它不在本站候选池，不要说成搜索失败。）"
    )
    return 4, ctx, game


async def answer_stream(
    db,
    message: str,
    *,
    mode: str = "fast",
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    game_hint: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """跑一次规则问答，产出 (event, payload)：level → delta* → done。

    优化：先查热点答案缓存，命中则秒回（首字≈0）；未命中再走正常检索+生成，
    并把依据明确（L1/L2/L3）的答案写回缓存。缓存只存「已验证正确」的答案，
    不改变任何检索参数，与检索质量无关。
    """
    # 主题游戏（含历史追问）—— 同时用于缓存 key，避免追问串到其它游戏
    topic_game, _src = await _resolve_game(db, message, game_id, game_hint, history)
    cache_game_id = topic_game.id if topic_game else None

    # 1) 热点缓存：命中直接秒回，绕开「改写 LLM + 生成 LLM（推理思维链）」长链路
    if settings.ANSWER_CACHE_ENABLED:
        hit = await answer_cache.get(cache_game_id, message)
        if hit:
            label = LEVEL_LABEL.get(hit["level"], "")
            yield "level", json.dumps(
                {
                    "level": hit["level"],
                    "label": label,
                    "game": hit.get("game_name"),
                    "cached": True,
                },
                ensure_ascii=False,
            )
            tag = "精确" if hit["hit"] == "exact" else f"近似 {hit.get('sim')}"
            yield "info", json.dumps(
                {"text": f"（命中高频问题缓存，已秒回 · {tag}）"}, ensure_ascii=False
            )
            for piece in _chunk(hit["text"]):
                yield "delta", piece
            yield "done", json.dumps(
                {"level": hit["level"], "label": label, "chars": len(hit["text"]), "cached": True},
                ensure_ascii=False,
            )
            return

    # 2) 正常路径：分层检索 + 生成
    level, context, game = await retrieve_layered(db, message, game_id, game_hint, history)
    label = LEVEL_LABEL[level]
    yield "level", json.dumps(
        {"level": level, "label": label, "game": game.name if game else None},
        ensure_ascii=False,
    )

    prompt_msgs = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT.format(
                level_label=label, mode_desc=rag.MODE_DESC.get(mode, rag.MODE_DESC["fast"])
            ),
        },
    ]
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

    total = 0
    buf: list[str] = []
    try:
        async for kind, piece in llm.chat_stream(
            prompt_msgs,
            temperature=0.3,
            max_tokens=MAX_TOKENS_BY_MODE.get(mode, MAX_TOKENS_BY_MODE["fast"]),
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

    # 3) 写回缓存（仅依据明确的层级，绝不缓存 L4 未验证）
    if level in (1, 2, 3):
        await answer_cache.put(
            game.id if game else None, message, "".join(buf), level,
            settings.LLM_RULE_MODEL or settings.LLM_MODEL,
            game_name=game.name if game else None,
        )
