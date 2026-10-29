"""Agent 编排层：主 Agent 编排（LLM 驱动派发）→ 回落确定性 Router → 两条独立流水线。

层次（自上而下，任一层失败都回落下一层，保证永不空答）：
1. Orchestrator（真 Agent）：LLM 带 2 个 function-calling 工具（规则/推荐副 Agent），
   由模型决定调 1 个还是 2 个、并综合复合意图。见 agent/orchestrator.py。
2. 确定性 Router（兜底）：关键词优先 + LLM 结构化兜底，二选一派发到下面两条流水线。
3. 两条流水线：规则问答（检索 + 带引用生成）/ 桌游推荐（过滤 + 排序 + 写理由）。

为什么主 Agent 之下仍保留确定性 Router 作兜底：自主派发是新加的，任何 LLM 失败
（额度/超时/不可用）都要能无缝退回可控的确定性路径，而不是整条链路崩掉。

历史：早期曾用自主工具循环（create_react_agent），后因两条路径确定性都极高、让模型
每次自主选工具只增不确定/token/延迟而废弃，改为 Router；本次在此之上再包一层
Orchestrator 以补上「复合意图可分解」这一真实缺口。

有界性（C5）：主 Agent 最多 2 次工具调用 + 墙钟上限；Router 单次路由 + 单条流水线，无自主循环。
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
from app.agent import orchestrator as orch_mod
from app.agent import llm
from app.core.config import settings

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
    history: list[tuple[str, str]] | None = None,
    game_id: int | None = None,
    trace_id: str | None = None,
    dialogue_state: dict | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """跑一次完整流程，产出 (event, payload)。

    事件：route（路由结果）/ level（规则问答的依据层级）/ notice（如实说明的降级提示）
         / delta（正文）/ done（结束）。
    dialogue_state：对话状态（话题游戏/实体上下文/槽位），由 ai.py 加载与回写，
    用于追问自动带上上一轮主题（如「那掷出 7 但没资源呢」→ 带上卡坦岛+强盗）。
    """
    trace = trace_id or uuid.uuid4().hex[:12]
    t0 = time.monotonic()

    # ── 主 Agent 编排（真 Agent）：LLM 驱动派发 ──
    # 优先走 Orchestrator；任何失败/超时/关闭都回落到下方确定性 Router，保证永不空答。
    if llm.available() and getattr(settings, "AGENT_ORCHESTRATOR_ENABLED", True):
        try:
            async for event, payload in orch_mod.run_orchestrator_stream(
                db,
                message,
                user_id=user_id,
                history=history,
                game_id=game_id,
                trace_id=trace,
                dialogue_state=dialogue_state,
            ):
                yield event, payload
            return
        except Exception as e:  # noqa: BLE001 - Orchestrator 失败，回落确定性 Router
            log.warning("[trace=%s] Orchestrator 失败，回落确定性 Router：%s", trace, e)

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
            history=history,
            game_id=game_id,
            game_hint=route.game_hint,
            dialogue_state=dialogue_state,
        )
    else:
        stream = recommend.recommend_stream(
            db,
            message,
            user_id=user_id,
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
