"""Agent 编排层：意图路由 → 分发到「规则问答」或「桌游推荐」两条独立流水线。

为什么从自主工具循环（create_react_agent）改成 Router：
两条能力的实现路径差异极大——规则问答是「检索 + 带引用生成」，推荐是「过滤 + 排序 + 写理由」。
让模型每次自主决定调哪个工具，只会把不确定性、token 和延迟都抬上去，
而这两条路径本身都是确定性流水线。Router 更可控、可评测、更省。

LangChain 仍然在用，只是用在了真正需要它的地方：
- 意图分类：ChatOpenAI.with_structured_output（结构化输出）
- 两条流水线的生成：LCEL 链（prompt | model | StrOutputParser）流式输出

有界性（C5）：单次路由 + 单条流水线，无自主循环；整体有墙钟上限兜底。
任何异常一律上抛给 ai.py，由它回落到既有 RAG 工作流 / 站内检索，保证用户拿得到回答。
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import replace as _dc_replace

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import rag
from app.agent import recommend, router as router_mod, rule_qa

log = logging.getLogger(__name__)

# 墙钟上限：路由 + 一条流水线的总时长上限，超时即中止（由上层降级）
WALL_CLOCK_SEC = 90.0

CLARIFY_TEXT = (
    "我不太确定你想问的是「某款桌游的具体规则」还是「想让我推荐桌游」。\n"
    "你可以这样问：\n"
    "1. 问规则：璀璨宝石里拿宝石有什么限制？\n"
    "2. 求推荐：推荐 3 款 4 人能玩、一小时内结束的合作类游戏"
)


async def run_agent_stream(
    db: AsyncSession,
    message: str,
    *,
    user_id: int | None = None,
    mode: str = "fast",
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    trace_id: str | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """跑一次完整流程，产出 (event, payload)。

    事件：route（路由结果）/ level（规则问答的依据层级）/ notice（如实说明的降级提示）
         / delta（正文）/ done（结束）。
    """
    trace = trace_id or uuid.uuid4().hex[:12]
    t0 = time.monotonic()

    route = await router_mod.route(message, history)

    # 收敛：明确点名了站内收录的某款游戏时，「信息严重不足」不成立。
    # 真实缺陷：新会话里「阿瓦隆怎么样」可能被判 clarify → 回一段澄清模板，
    # 而它其实是候选池内的游戏（有规则书），完全答得出。
    if route.intent == router_mod.INTENT_CLARIFY:
        named = await rag.identify_game(db, message)
        if named is not None:
            intent = (
                router_mod.INTENT_REC
                if router_mod.GAME_FOCUS_PAT.search(message)
                else router_mod.INTENT_RULE
            )
            log.info(
                "[trace=%s] 点名站内游戏《%s》→ 由 clarify 收敛为 %s",
                trace, named.name, intent,
            )
            route = _dc_replace(route, intent=intent, game_hint=named.name, via="game-focus")

    log.info("[trace=%s] 路由结果 intent=%s via=%s", trace, route.intent, route.via)
    yield "route", json.dumps(
        {
            "intent": route.intent,
            "via": route.via,
            "game_hint": route.game_hint,
            "players": route.players,
            "play_time_max": route.play_time_max,
            "play_time_min": route.play_time_min,
            "keyword": route.keyword,
        },
        ensure_ascii=False,
    )

    # 占位前置：路由一出来就告诉前端「正在处理」，改善干等体感（真实延迟未变，但体感更好）
    if route.via == "game-focus":
        yield "tool", json.dumps({"text": "正在查询站内资料…"}, ensure_ascii=False)
    elif route.intent == router_mod.INTENT_RULE:
        yield "tool", json.dumps({"text": "正在检索规则库…"}, ensure_ascii=False)
    elif route.intent == router_mod.INTENT_REC:
        yield "tool", json.dumps({"text": "正在为你挑选游戏…"}, ensure_ascii=False)

    if route.intent == router_mod.INTENT_CLARIFY:
        yield "delta", CLARIFY_TEXT
        yield "done", json.dumps({"intent": route.intent, "trace_id": trace})
        return

    if route.intent == router_mod.INTENT_RULE:
        stream = rule_qa.answer_stream(
            db,
            message,
            mode=mode,
            history=history,
            game_id=game_id,
            game_hint=route.game_hint,
        )
    else:
        stream = recommend.recommend_stream(
            db,
            message,
            user_id=user_id,
            mode=mode,
            route=route,
            history=history,
        )

    async for event, payload in stream:
        if time.monotonic() - t0 > WALL_CLOCK_SEC:
            log.warning("[trace=%s] 达到墙钟上限 %.0fs，中止", trace, WALL_CLOCK_SEC)
            break
        yield event, payload

    yield "done", json.dumps(
        {
            "intent": route.intent,
            "trace_id": trace,
            "elapsed": round(time.monotonic() - t0, 2),
        },
        ensure_ascii=False,
    )
