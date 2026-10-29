"""对话状态模块（LangGraph Store 承载）。

目的：让追问场景自动携带上一轮的对话主题，避免用户重复游戏名。
    例："卡坦岛的强盗怎么用？" → "那掷出 7 但没资源呢？"
    第二句无游戏名与实体，检索时需要补上 topic_game + topic_context。

存储选型：LangGraph 的 AsyncPostgresStore（langgraph-checkpoint-postgres）。
    - namespace 按 (app, user_id) 隔离，key 为 session-{session_id}；
    - 后续若按分层方案把 Agent 循环迁到 LangGraph StateGraph，
      本模块的状态 schema 可直接作为图状态复用。

设计原则（与全项目一致）：
    - 存取全部 best-effort：任何异常只记日志并降级为空状态，
      绝不影响聊天主流程（对应"永不空答"哲学）；
    - 更新逻辑为纯函数（update_from_turn），可单测、可离线回放；
    - 实体级上下文采用确定性提取（存上一条规则类提问的原文片段），
      不引入额外 LLM 调用，检索由 BM25/向量的词频与语义加权兜住噪声。
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from datetime import datetime
from typing import Any, Optional

from app.core.config import settings

log = logging.getLogger("tablemind.agent.dialogue_state")

try:  # 依赖缺失时静默降级为不启用
    from langgraph.store.postgres.aio import AsyncPostgresStore
except ImportError:  # pragma: no cover
    AsyncPostgresStore = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# 状态 schema（未来可直接作为 LangGraph 图状态）
# ---------------------------------------------------------------------------

def empty_state() -> dict:
    return {
        "topic_game_id": None,      # 当前话题游戏 id（来自规则问答的 level 事件）
        "topic_game_name": None,    # 当前话题游戏名
        "topic_context": "",        # 上一条规则类提问原文片段（实体级上下文替身）
        "last_intent": None,        # rule / rec / None
        "open_slots": {},           # 跨轮槽位：players / play_time_max / play_time_min / keyword
        "updated_at": None,
    }

def _normalize(state: Optional[dict]) -> dict:
    base = empty_state()
    if not state:
        return base
    for key, value in state.items():
        if key in base:
            base[key] = value
    return base

# ---------------------------------------------------------------------------
# Store 生命周期（进程内单例，风格与 llm.py 一致；由 main 的 lifespan 驱动）
# ---------------------------------------------------------------------------

_store: Optional["AsyncPostgresStore"] = None
_stack: Optional[AsyncExitStack] = None

_NAMESPACE = ("tablemind", "dialogue_state")

def _conn_uri() -> str:
    # SQLAlchemy 的 postgresql+asyncpg:// → psycopg3 的 postgresql://
    return settings.DATABASE_URL.replace("+asyncpg", "")

def enabled() -> bool:
    return bool(settings.DIALOGUE_STATE_ENABLED) and _store is not None

async def init_store() -> None:
    """应用启动时调用：建立连接池并创建 store 表。失败仅降级，不阻断启动。"""
    global _store, _stack
    if not settings.DIALOGUE_STATE_ENABLED:
        log.info("对话状态未启用（DIALOGUE_STATE_ENABLED=False）")
        return
    if AsyncPostgresStore is None:
        log.warning("langgraph-checkpoint-postgres 未安装，对话状态降级为不启用")
        return
    try:
        _stack = AsyncExitStack()
        store = await _stack.enter_async_context(
            AsyncPostgresStore.from_conn_string(_conn_uri())
        )
        await store.setup()  # 幂等建表
        _store = store
        log.info("对话状态存储已就绪（LangGraph AsyncPostgresStore）")
    except Exception as exc:  # noqa: BLE001
        await close_store()
        log.warning("对话状态存储初始化失败（已降级为不启用）：%s", exc)

async def close_store() -> None:
    global _store, _stack
    stack, _stack = _stack, None
    _store = None
    if stack is not None:
        try:
            await stack.aclose()
        except Exception:  # noqa: BLE001
            pass

# ---------------------------------------------------------------------------
# 存取（best-effort）
# ---------------------------------------------------------------------------

def _key(session_id: int) -> str:
    return f"session-{session_id}"

async def load(user_id: int, session_id: int) -> dict:
    """读取会话对话状态；未启用/异常时返回空状态。"""
    if not enabled() or not session_id:
        return empty_state()
    try:
        item = await _store.aget(_NAMESPACE + (str(user_id),), _key(session_id))
        return _normalize(item.value if item else None)
    except Exception as exc:  # noqa: BLE001
        log.warning("对话状态读取失败（降级为空状态）：%s", exc)
        return empty_state()

async def save(user_id: int, session_id: int, state: dict) -> None:
    """写入会话对话状态；未启用/异常时静默跳过。"""
    if not enabled() or not session_id:
        return
    try:
        payload = _normalize(state)
        payload["updated_at"] = datetime.now().isoformat(timespec="seconds")
        await _store.aput(_NAMESPACE + (str(user_id),), _key(session_id), payload)
    except Exception as exc:  # noqa: BLE001
        log.warning("对话状态写入失败（忽略）：%s", exc)

# ---------------------------------------------------------------------------
# 轮次更新（纯函数）
# ---------------------------------------------------------------------------

_SLOT_KEYS = ("players", "play_time_max", "play_time_min", "keyword")

def update_from_turn(
    state: Optional[dict],
    *,
    message: str,
    route: Optional[dict] = None,
    level: Optional[dict] = None,
) -> dict:
    """根据本轮的路由事件与层级事件更新对话状态。

    - route: ai.py 捕获的 {"intent", "players", "play_time_max", ..., "game_hint"}
    - level: rule_qa 发出的 {"level", "label", "game", "game_id"}
    """
    s = _normalize(state)
    intent = (route or {}).get("intent")

    # 1) 意图与槽位：rule / rec 才更新话题；clarify 不改变主题
    if intent in ("rule", "rec"):
        s["last_intent"] = intent
        merged = {k: v for k, v in (s.get("open_slots") or {}).items() if v}
        for k in _SLOT_KEYS:
            v = (route or {}).get(k)
            if v is not None:
                merged[k] = v
        s["open_slots"] = merged

    # 2) 话题游戏：以规则问答返回的实际游戏为准（level 事件带 game_id）
    if level and level.get("game_id"):
        s["topic_game_id"] = int(level["game_id"])
        s["topic_game_name"] = level.get("game") or None
        if s["last_intent"] not in ("rule", "rec"):
            s["last_intent"] = "rule"

    # 3) 实体级上下文：仅在规则问答轮刷新（确定性提取：存提问原文片段）
    if intent == "rule" or (level and level.get("game_id")):
        s["topic_context"] = (message or "").strip()[:60]

    return s

# ---------------------------------------------------------------------------
# 检索查询合成
# ---------------------------------------------------------------------------

def build_retrieval_query(message: str, game_name: str, state: Optional[dict]) -> str:
    """把话题游戏与实体上下文合进检索查询。

    例：game_name="卡坦岛"，topic_context="卡坦岛的强盗怎么用"，message="那掷出7但没资源呢"
        → "卡坦岛 卡坦岛的强盗怎么用 那掷出7但没资源呢"
    BM25 侧按 set 去重、无关 bigram 由 idf 压权；向量侧语义取并集，均无害。
    """
    parts = [game_name]
    ctx = ((state or {}).get("topic_context") or "").strip()
    if ctx and ctx not in message:
        parts.append(ctx)
    parts.append((message or "").strip())
    return " ".join(p for p in parts if p)
