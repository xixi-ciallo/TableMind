"""Agent 工具的 LangChain 实现：5 个 L0 只读工具，复用既有真实 DB 逻辑。

设计遵循五原则：一个工具一件事、工具名即文档（用 docstring 写「何时用」）、参数最小化
（db / user_id 由闭包注入，不让模型填）、全部只读故无 human-in-the-loop。

工具一律接受**游戏名**而非 game_id：服务端用 rag.identify_game 解析；实测模型无从得知 ID。
实现基于 LangChain（langgraph.prebuilt.create_react_agent），工具用 @tool 装饰，描述即准则。
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from langchain_core.tools import tool

from app.agent import rag
from app.agent import tools as db_tools

# 结果截断：巨型结果会撑爆上下文，截断永远好过报错
MAX_RESULT_CHARS = 4000
# 数据库查询超时：慢查询重试通常是帮倒忙，故不重试只超时
DB_TIMEOUT_SEC = 3.0
# 单个工具累计调用上限：实测中模型会换个参数反复搜同一个库，
# 「完全相同参数」的去重拦不住这种行为，必须按工具名硬性计数。
MAX_CALLS_PER_TOOL = 3


def _truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"...[已截断 {len(text) - limit} 字]"


# ---- 以下 _run_* 为真实 DB 逻辑（复用改造前已验证的查询），返回纯文本结果 ----


async def _run_rule_chunks(db, args: dict) -> str:
    name = str(args.get("game_name") or "").strip()
    query = str(args.get("query") or "").strip()
    if not name:
        return "错误：缺少 game_name 参数"
    game = await rag.identify_game(db, name)
    if game is None:
        return f"未能在站内匹配到名为「{name}」的桌游，请换用更完整的名称再试。"
    top_k = int(args.get("top_k") or 5)
    chunks = await rag.retrieve_rule_chunks(db, game.id, query or name, k=max(1, min(top_k, 8)))
    if not chunks:
        return f"站内暂未收录《{game.name}》的规则说明书，无法引用原文；请如实告知用户这一点。"
    body = "\n\n".join(f"片段{i + 1}：{c}" for i, c in enumerate(chunks))
    return f"《{game.name}》规则说明书片段（共 {len(chunks)} 段）：\n\n{body}"


async def _run_search_games(db, args: dict) -> str:
    rows = await db_tools.search_games(
        db,
        keywords=args.get("keyword"),
        min_players=args.get("min_players"),
        max_players=args.get("max_players"),
        play_time=args.get("play_time_max"),
        complexity=args.get("complexity_max"),
        limit=int(args.get("limit") or 8),
    )
    if not rows:
        return "没有符合条件的桌游。请不要换关键词反复重试，直接如实告知用户没有匹配结果。"
    return f"命中 {len(rows)} 款：\n{json.dumps(rows, ensure_ascii=False, indent=1)}"


async def _run_game_detail(db, args: dict) -> str:
    name = str(args.get("game_name") or "").strip()
    if not name:
        return "错误：缺少 game_name 参数"
    game = await rag.identify_game(db, name)
    if game is None:
        return f"未能在站内匹配到名为「{name}」的桌游。"
    detail = await db_tools.get_game_detail(db, game.id)
    return json.dumps(detail, ensure_ascii=False, indent=1) if detail else "未取到该桌游的资料。"


async def _run_collection(db, args: dict, user_id) -> str:
    if user_id is None:
        return "当前会话未关联登录用户，无法查询收藏。"
    rows = await db_tools.get_user_collection(db, user_id)
    return (
        f"该用户收藏 {len(rows)} 款：\n{json.dumps(rows, ensure_ascii=False, indent=1)}"
        if rows
        else "该用户暂无收藏记录。"
    )


async def _run_random(db, args: dict) -> str:
    limit = int(args.get("limit") or 5)
    rows = await db_tools.random_picks(db, limit=max(1, min(limit, 10)))
    return f"随机取 {len(rows)} 款：\n{json.dumps(rows, ensure_ascii=False, indent=1)}"


async def _safe(coro, name: str) -> str:
    """超时 + 结构化失败，永不上抛；截断结果避免撑爆上下文。"""
    try:
        out = await asyncio.wait_for(coro, DB_TIMEOUT_SEC)
        return _truncate(out)
    except asyncio.TimeoutError:
        return f"错误：工具 {name} 查询超时（>{DB_TIMEOUT_SEC}s），请换更宽泛的条件重试。"
    except Exception as e:  # noqa: BLE001
        return f"错误：工具 {name} 执行失败：{type(e).__name__}: {e}"


def build_tools(db, user_id=None) -> list:
    """为一次 Agent 运行构造 5 个 LangChain 工具（闭包注入 db / user_id / 每请求调用计数器）。

    counters 每次调用 build_tools 新建 → 天然并发安全（不会跨请求串）。
    每个工具内部都有 MAX_CALLS_PER_TOOL 硬性计数：超限直接返回「停止调用并回答」，
    兜住模型换参数反复搜同一库的行为。
    """
    counters: dict[str, int] = {}

    @tool
    async def get_rule_chunks(game_name: str, query: str, top_k: int = 5) -> str:
        """检索某款桌游的规则说明书原文片段。仅在用户询问具体玩法、回合流程、计分方式、卡牌或配件作用等规则细节时使用；若用户只是求推荐、对比或问基本信息，不要调用。"""
        counters["get_rule_chunks"] = counters.get("get_rule_chunks", 0) + 1
        if counters["get_rule_chunks"] > MAX_CALLS_PER_TOOL:
            return (
                f"get_rule_chunks 已调用 {MAX_CALLS_PER_TOOL} 次仍未解决，"
                "请停止调用并直接基于已有结果回答用户；查不到如实说明本站暂无该信息。"
            )
        return await _safe(
            _run_rule_chunks(db, {"game_name": game_name, "query": query, "top_k": top_k}),
            "get_rule_chunks",
        )

    @tool
    async def search_games(
        min_players: Optional[int] = None,
        max_players: Optional[int] = None,
        play_time_max: Optional[int] = None,
        complexity_max: Optional[float] = None,
        keyword: Optional[str] = None,
        limit: int = 8,
    ) -> str:
        """按人数、时长、复杂度或关键词查询桌游库，返回真实收录结果。用于推荐、筛选、找同类游戏；只在用户给出可匹配的条件时使用。"""
        counters["search_games"] = counters.get("search_games", 0) + 1
        if counters["search_games"] > MAX_CALLS_PER_TOOL:
            return (
                f"search_games 已调用 {MAX_CALLS_PER_TOOL} 次仍未解决，"
                "请停止调用并直接基于已有结果回答用户；确实查不到就如实说明本站暂无该信息。"
            )
        args = {
            "keyword": keyword,
            "min_players": min_players,
            "max_players": max_players,
            "play_time_max": play_time_max,
            "complexity_max": complexity_max,
            "limit": limit,
        }
        return await _safe(_run_search_games(db, args), "search_games")

    @tool
    async def get_game_detail(game_name: str) -> str:
        """查询某款桌游的完整收录资料（人数、时长、适龄、出版社、简介）。用于用户问某款游戏的概况时；若问的是规则细节，改用 get_rule_chunks。"""
        counters["get_game_detail"] = counters.get("get_game_detail", 0) + 1
        if counters["get_game_detail"] > MAX_CALLS_PER_TOOL:
            return f"get_game_detail 已调用 {MAX_CALLS_PER_TOOL} 次仍未解决，请停止调用并直接基于已有结果回答用户。"
        return await _safe(_run_game_detail(db, {"game_name": game_name}), "get_game_detail")

    @tool
    async def get_user_collection() -> str:
        """查询当前登录用户已收藏 / 玩过 / 拥有的桌游，避免重复推荐。仅在用户提到「我收藏的」「我玩过的」「我已经有」这类表述时使用。"""
        counters["get_user_collection"] = counters.get("get_user_collection", 0) + 1
        if counters["get_user_collection"] > MAX_CALLS_PER_TOOL:
            return f"get_user_collection 已调用 {MAX_CALLS_PER_TOOL} 次仍未解决，请停止调用并直接基于已有结果回答用户。"
        return await _safe(_run_collection(db, {}, user_id), "get_user_collection")

    @tool
    async def random_picks(limit: int = 5) -> str:
        """从站内真实收录中随机取若干款。仅在用户没有任何明确条件、只是「随便推荐」时使用。"""
        counters["random_picks"] = counters.get("random_picks", 0) + 1
        if counters["random_picks"] > MAX_CALLS_PER_TOOL:
            return f"random_picks 已调用 {MAX_CALLS_PER_TOOL} 次仍未解决，请停止调用并直接基于已有结果回答用户。"
        return await _safe(_run_random(db, {"limit": limit}), "random_picks")

    return [get_rule_chunks, search_games, get_game_detail, get_user_collection, random_picks]
