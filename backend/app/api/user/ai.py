"""AI 助手：对话真实落库，回复由大模型基于本站真实收录资料生成。

大模型走 /ai/chat/stream（SSE 流式）；/ai/chat 为非流式兜底，两者共用同一套
检索上下文。大模型不可用（未配置密钥 / 鉴权失败 / 超时 / 服务端异常）时自动
降级为站内资料检索，并在回复里如实说明，绝不编造答案。
"""
import asyncio
import json
import logging
import random
import re
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import llm, rag
from app.agent import loop as agent_loop
from app.agent import memory as mem_mod
from app.core.config import settings
from app.api.deps import get_current_user, get_db
from app.models.board_game import BoardGame
from app.models.chat import ChatMessage, ChatSession
from app.models.user import User
from app.schemas.chat import ChatRequest

router = APIRouter()

MAX_MESSAGE_LEN = 2000
FALLBACK_TIP = "（说明：大模型调用未成功，以上为本站资料检索结果，均来自真实收录数据）"
FALLBACK_RULE_TIP = "（说明：大模型调用未成功，以上为本站规则说明书原文摘录，未经改写；如需讲解可稍后重试）"
# 降级摘录的展示上限：兜底不是把整本规则书倒给用户
MAX_SNIPPET_LEN = 1600

# 降级路径的问题类型判别：命中则优先给「规则书原文」而不是游戏简介。
# 起因：大模型不可用时，「三国杀怎么玩」被回成一段游戏简介 +「你问的应该是这几款」，
# 答非所问——用户要的是规则，库里明明有 15 片三国杀规则切片却没有被用上。
_RULE_Q_PAT = re.compile(
    r"怎么玩|怎么打|玩法|规则|教程|怎么用|如何|结算|计分|算分|得分|胜利条件|"
    r"怎么算|游戏准备|开局|回合|阶段|行动|流程|set\s?up",
    re.IGNORECASE,
)

# 推理模型的思维链也计入 max_tokens，按模式给不同上限
MAX_TOKENS = {"fast": 1200, "deep": 2000}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _summarize(g: BoardGame, deep: bool = False) -> str:
    """把一款真实桌游整理成一段可直接展示的简介（只用库内真实字段）。

    deep=True 时额外展开适龄、复杂度、分类与机制，并把介绍放长——对应前端「深度」模式。
    """
    bits: list[str] = []
    if g.year_published:
        bits.append(f"{g.year_published} 年出版")
    if g.min_players and g.max_players:
        bits.append(f"{g.min_players}-{g.max_players} 人")
    if g.play_time_minutes:
        bits.append(f"单局约 {g.play_time_minutes} 分钟")
    if g.publisher:
        bits.append(g.publisher)

    head = f"《{g.name}》" + (f"（{' / '.join(bits)}）" if bits else "")

    extra: list[str] = []
    if deep:
        if g.min_age:
            extra.append(f"适龄 {g.min_age}+")
        if g.complexity:
            extra.append(f"复杂度 {g.complexity}/5")
        if g.categories:
            extra.append("分类：" + "、".join(str(c) for c in g.categories[:4]))
        if g.mechanics:
            extra.append("机制：" + "、".join(str(m) for m in g.mechanics[:4]))

    limit = 260 if deep else 60
    desc = (g.description or "").strip().replace("\n", " ")
    if len(desc) > limit:
        desc = desc[:limit] + "…"

    lines = [head]
    if extra:
        lines.append(" · ".join(extra))
    if desc:
        lines.append(desc)
    return "\n".join(lines)


def _filter_by_players(games: list[BoardGame], message: str) -> list[BoardGame]:
    """按「N 人」关键词过滤（真实字段过滤，不做任何推断）。"""
    want: int | None = None
    for word, n in (("2人", 2), ("两人", 2), ("双人", 2), ("3人", 3), ("三人", 3), ("4人", 4), ("四人", 4)):
        if word in message:
            want = n
            break
    if want is None:
        return []
    return [
        g
        for g in games
        if g.min_players and g.max_players and g.min_players <= want <= g.max_players
    ]


async def _fallback_rule_snippets(
    db: AsyncSession, message: str, k: int = 2, timeout: float = 8.0
) -> tuple[BoardGame, list[str]] | None:
    """降级路径的规则检索：定位游戏 → 取规则说明书原文切片（含相邻切片，保证读得通）。

    整段 best-effort：异常或超时都返回 None，由调用方回落到游戏简介逻辑。
    加超时的原因：降级发生在「大模型刚失败」的时刻，查询改写（要调 LLM）可能继续
    卡住，不能让兜底路径反而比主路径更慢。
    """

    async def _run() -> tuple[BoardGame, list[str]] | None:
        game = await rag.identify_game(db, message)
        if game is None:
            return None
        hits = await rag.retrieve_rule_chunk_hits(db, game.id, message, k=k, expand=1)
        return (game, [c for _i, c in hits]) if hits else None

    try:
        return await asyncio.wait_for(_run(), timeout=timeout)
    except Exception:  # noqa: BLE001 - 兜底路径绝不能再抛错
        return None


async def _fallback_reply(db: AsyncSession, message: str, mode: str = "fast") -> str:
    """降级路径：大模型不可用时，直接返回站内真实资料（按 mode 决定详略）。

    先判意图：规则类问题（「XX 怎么玩」）优先给规则说明书原文摘录；
    取不到再回落到原来的「命中游戏名 → 给简介」逻辑。
    """
    deep = mode == "deep"

    # 1) 规则类问题：本站 47 款均收录了规则说明书，直接给原文切片
    if _RULE_Q_PAT.search(message):
        got = await _fallback_rule_snippets(db, message, k=3 if deep else 2)
        if got:
            game, chunks = got
            body = "\n\n".join(c.strip() for c in chunks if c and c.strip())
            if len(body) > MAX_SNIPPET_LEN:
                body = body[:MAX_SNIPPET_LEN].rstrip() + "…（原文较长，已截断）"
            if body:
                return "\n\n".join(
                    [f"《{game.name}》规则说明书原文摘录：", body, FALLBACK_RULE_TIP]
                )

    games = (await db.execute(select(BoardGame).order_by(BoardGame.id))).scalars().all()
    if not games:
        return "本站还没有收录桌游数据，暂时无法为你检索。"

    # 命中游戏名：直接给出该游戏真实资料
    hits = [g for g in games if g.name and g.name in message]
    if hits:
        lines = ["你问的应该是这几款："] + [_summarize(g, deep) for g in hits[: (3 if deep else 2)]]
        lines.append(FALLBACK_TIP)
        return "\n\n".join(lines)

    # 未命中：按人数关键词过滤后推荐，否则给收录顺序靠前的真实游戏
    take = 5 if deep else 3
    picks = _filter_by_players(games, message)[:take] or games[:take]
    lines = ["这句话里没找到具体游戏名，先给你几款站内真实收录的桌游："] + [
        _summarize(g, deep) for g in picks
    ]
    lines.append(FALLBACK_TIP)
    return "\n\n".join(lines)


async def _prepare_session(
    db: AsyncSession, user_id: int, session_id: int | None, msg: str
) -> tuple[int, list[tuple[str, str]]]:
    """定位/创建会话并落库用户消息，返回 (session_id, 历史消息)。"""
    session: ChatSession | None = None
    if session_id:
        session = await db.get(ChatSession, session_id)
        if session and session.user_id != user_id:
            raise HTTPException(status_code=403, detail="无权访问该会话")
    if session is None:
        session = ChatSession(user_id=user_id)
        db.add(session)
        await db.flush()

    history = await _load_history(db, session.id)
    db.add(ChatMessage(session_id=session.id, role="user", content=msg))
    await db.commit()
    return session.id, history


async def _load_history(db: AsyncSession, session_id: int, limit: int = 10) -> list[tuple[str, str]]:
    """读取会话最近若干条消息，作为大模型的多轮上下文。"""
    rows = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [(m.role, m.content) for m in reversed(rows)]


async def _generate(
    db: AsyncSession,
    message: str,
    mode: str,
    history: list[tuple[str, str]],
    user_id: int,
    game_id: int | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """统一的回复生成：产出 (事件名, 内容)。

    优先级：Agent 工具调用循环 → 固定 RAG 工作流 → 站内检索兜底。
    事件为 'meta' / 'tool' / 'thinking' / 'delta' / 'notice' / 'error' / 'fallback'。
    """
    # 灰度：按比例把部分流量切到固定 RAG 路径，用于对比延迟/准确率（0=全走 Agent）
    use_agent = bool(llm.available() and settings.AGENT_ENABLED)
    if use_agent and settings.AI_CANARY_RATIO > 0 and random.random() < settings.AI_CANARY_RATIO:
        log.info("灰度命中：本次走固定 RAG 路径（AI_CANARY_RATIO=%.2f）", settings.AI_CANARY_RATIO)
        use_agent = False

    # 1) Agent 路径：由模型自主决定查什么资料、要不要查
    if use_agent:
        yield "meta", json.dumps({"source": "agent", "model": llm.model_name()}, ensure_ascii=False)
        try:
            async for event, payload in agent_loop.run_agent_stream(
                db, message, user_id=user_id, mode=mode, history=history, game_id=game_id
            ):
                # 路由结果 / 依据层级 / 降级提示 / 正文，都要透给前端
                if event in ("route", "level", "info", "notice", "tool", "delta"):
                    yield event, payload
            return
        except Exception as e:  # noqa: BLE001 - Agent 任何失败都降级，保证用户拿得到回答
            logging.getLogger(__name__).warning("Agent 路径失败，降级到 RAG 工作流：%s", e)
            yield "notice", json.dumps({"text": "工具调用未成功，已改用站内资料检索"}, ensure_ascii=False)

    # 2) 固定 RAG 工作流（改造前的路径，作为 Agent 的降级与关闭时的默认行为）
    messages = await rag.build_messages(
        db, message, mode=mode, history=history, user_id=user_id, game_id=game_id
    )

    if llm.available():
        yield "meta", json.dumps({"source": "llm", "model": llm.model_name()}, ensure_ascii=False)
        thinking_sent = False
        try:
            async for kind, text in llm.chat_stream(
                messages, temperature=0.6, max_tokens=MAX_TOKENS.get(mode, 1200)
            ):
                if kind == "reasoning":
                    if not thinking_sent:
                        thinking_sent = True
                        yield "thinking", "正在思考…"
                    continue
                if text:
                    yield "delta", text
            return
        except llm.LLMError as e:
            # 已吐出的正文丢弃，整体改用降级结果，避免出现半截答案。
            # 具体原因（额度耗尽 / 鉴权 / 超时…）必须落日志：前端只拿到一句降级提示，
            # 不记日志的话「为什么降级」在服务端就查不到了。
            logging.getLogger(__name__).warning("大模型调用失败，改用站内资料兜底：%s", e.message)
            yield "error", e.message

    yield "meta", json.dumps({"source": "fallback", "model": None}, ensure_ascii=False)
    reply = await _fallback_reply(db, message, mode)
    yield "fallback", reply


@router.get("/status")
async def ai_status():
    """前端据此显示「由哪个模型回答 / 是否降级」，无需登录。"""
    return {
        "llm_enabled": llm.available(),
        "model": llm.model_name() if llm.available() else None,
    }


@router.post("/chat")
async def chat(
    data: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """非流式兜底：一次性返回完整回复（前端默认走 /chat/stream）。"""
    msg = (data.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if len(msg) > MAX_MESSAGE_LEN:
        raise HTTPException(status_code=400, detail=f"单条消息不能超过 {MAX_MESSAGE_LEN} 字")

    mode = data.mode if data.mode in ("fast", "deep") else "fast"
    session_id, history = await _prepare_session(db, current_user.id, data.session_id, msg)

    source = "fallback"
    model: str | None = None
    chunks: list[str] = []
    async for event, payload in _generate(db, msg, mode, history, current_user.id, data.game_id):
        if event == "meta":
            info = json.loads(payload)
            source = info.get("source", "fallback")
            model = info.get("model")
        elif event == "delta":
            chunks.append(payload)
        elif event == "fallback":
            chunks = [payload]

    reply = "".join(chunks).strip() or "抱歉，这次没能生成回答，请再试一次。"
    db.add(ChatMessage(session_id=session_id, role="assistant", content=reply))
    await db.commit()

    # 蒸馏用户记忆（best-effort 后台任务，使用独立会话，不阻塞回复）
    if settings.MEMORY_DISTILL_ENABLED and current_user.id and reply:
        asyncio.create_task(mem_mod.distill_from_exchange(current_user.id, msg, reply))

    return {"session_id": session_id, "reply": reply, "source": source, "model": model}


@router.post("/chat/stream")
async def chat_stream(
    data: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """SSE 流式对话：meta → thinking? → delta* → done（或 error + 降级 fallback）。"""
    msg = (data.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if len(msg) > MAX_MESSAGE_LEN:
        raise HTTPException(status_code=400, detail=f"单条消息不能超过 {MAX_MESSAGE_LEN} 字")

    mode = data.mode if data.mode in ("fast", "deep") else "fast"
    # 注意：session 与用户消息先落库并提交，流式期间不再占用事务
    session_id, history = await _prepare_session(db, current_user.id, data.session_id, msg)

    async def event_stream() -> AsyncIterator[str]:
        chunks: list[str] = []
        source = "fallback"
        model: str | None = None
        intent = None

        async for event, payload in _generate(db, msg, mode, history, current_user.id, data.game_id):
            if event == "meta":
                info = json.loads(payload)
                source = info.get("source", "fallback")
                model = info.get("model")
                yield _sse("meta", {"session_id": session_id, "source": source, "model": model})
            elif event == "thinking":
                yield _sse("thinking", {"text": payload})
            elif event == "tool":
                # Agent 正在调用工具，前端可展示"正在查询…"
                yield _sse("tool", {"text": payload})
            elif event == "delta":
                chunks.append(payload)
                yield _sse("delta", {"text": payload})
            elif event == "notice":
                yield _sse("notice", json.loads(payload))
            elif event == "info":
                yield _sse("info", json.loads(payload))
            elif event == "level":
                # 规则问答的依据层级（L1结构化 / L2规则书 / L3 BGG / L4未验证）
                yield _sse("level", json.loads(payload))
            elif event == "route":
                try:
                    intent = json.loads(payload).get("intent")
                except (ValueError, KeyError):
                    intent = None
                yield _sse("route", json.loads(payload))
            elif event == "error":
                chunks = []
                yield _sse("notice", {"text": payload})
            elif event == "fallback":
                chunks = [payload]
                yield _sse("delta", {"text": payload})

        reply = "".join(chunks).strip() or "抱歉，这次没能生成回答，请再试一次。"
        db.add(ChatMessage(session_id=session_id, role="assistant", content=reply))
        await db.commit()
        # 蒸馏用户记忆（best-effort 后台任务，使用独立会话，不阻塞回复）
        if settings.MEMORY_DISTILL_ENABLED and current_user.id and reply:
            asyncio.create_task(mem_mod.distill_from_exchange(current_user.id, msg, reply))
        yield _sse("done", {"session_id": session_id, "reply": reply, "source": source, "model": model})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/history")
async def chat_history(
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """我的 AI 对话历史：按最近活动时间倒序，带首条提问预览与消息数。"""
    # 每个会话里首条用户消息的 id（用于取预览文本）
    first_id = (
        select(func.min(ChatMessage.id))
        .where(ChatMessage.session_id == ChatSession.id, ChatMessage.role == "user")
        .correlate(ChatSession)
        .scalar_subquery()
    )
    preview = (
        select(ChatMessage.content).where(ChatMessage.id == first_id).scalar_subquery()
    )

    rows = (
        await db.execute(
            select(
                ChatSession.id,
                ChatSession.created_at,
                func.max(ChatMessage.created_at).label("last_at"),
                func.count(ChatMessage.id).label("message_count"),
                preview.label("preview"),
            )
            .join(ChatMessage, ChatMessage.session_id == ChatSession.id)
            .where(ChatSession.user_id == current_user.id)
            .group_by(ChatSession.id, ChatSession.created_at)
            .order_by(func.max(ChatMessage.created_at).desc())
            .limit(limit)
        )
    ).all()

    return [
        {
            "session_id": sid,
            "created_at": created_at,
            "last_at": last_at,
            "message_count": int(message_count),
            "preview": (preview_text or "").strip(),
        }
        for sid, created_at, last_at, message_count, preview_text in rows
    ]


@router.delete("/history")
async def clear_history(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """清空我的全部 AI 对话（先删消息再删会话：chat_messages 外键没有级联）。"""
    ids = (
        (
            await db.execute(
                select(ChatSession.id).where(ChatSession.user_id == current_user.id)
            )
        )
        .scalars()
        .all()
    )
    if not ids:
        return {"deleted": 0}

    await db.execute(delete(ChatMessage).where(ChatMessage.session_id.in_(ids)))
    await db.execute(delete(ChatSession).where(ChatSession.user_id == current_user.id))
    await db.commit()
    return {"deleted": len(ids)}


@router.delete("/history/{session_id}")
async def delete_session(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除单条历史会话（只能删自己的）。"""
    session = await db.get(ChatSession, session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会话不存在")

    await db.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
    await db.delete(session)
    await db.commit()
    return {"deleted": 1}


@router.get("/history/{session_id}")
async def session_messages(
    session_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """某个会话的完整消息（只能看自己的）。"""
    session = await db.get(ChatSession, session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="会话不存在")

    msgs = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id)
        )
    ).scalars().all()
    return [
        {"role": m.role, "content": m.content, "created_at": m.created_at} for m in msgs
    ]


class MemoryUpdate(BaseModel):
    """显式设置用户偏好的请求体（前端「我的偏好」表单用）。所有字段均可选。"""

    preferred_categories: list[str] | None = Field(default=None)
    preferred_mechanics: list[str] | None = Field(default=None)
    disliked_games: list[str] | None = Field(default=None)
    max_complexity: float | None = Field(default=None, ge=0, le=5)
    preferred_player_count: int | None = Field(default=None, ge=1, le=20)
    notes: str | None = Field(default=None)


@router.get("/memory")
async def get_memory(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """读取我的用户画像与近期情景记忆（个性化记忆，与 RAG 语义记忆分开存）。"""
    profile = await mem_mod.get_profile(db, current_user.id)
    episodes = await mem_mod.get_recent_episodes(db, current_user.id, limit=20)
    return {
        "profile": {
            "preferred_categories": profile.preferred_categories if profile else [],
            "preferred_mechanics": profile.preferred_mechanics if profile else [],
            "disliked_games": profile.disliked_games if profile else [],
            "max_complexity": profile.max_complexity if profile else None,
            "preferred_player_count": profile.preferred_player_count if profile else None,
            "notes": profile.notes if profile else "",
            "updated_at": profile.updated_at.isoformat() if profile and profile.updated_at else None,
        },
        "episodes": [
            {
                "id": e.id,
                "kind": e.kind,
                "content": e.content,
                "game_name": e.game_name,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in episodes
        ],
    }


@router.put("/memory")
async def update_memory(
    data: MemoryUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """显式更新我的偏好画像（合并式，与蒸馏写入走同一套 upsert 逻辑）。"""
    await mem_mod.upsert_profile(
        db,
        current_user.id,
        categories=data.preferred_categories,
        mechanics=data.preferred_mechanics,
        disliked_games=data.disliked_games,
        max_complexity=data.max_complexity,
        preferred_player_count=data.preferred_player_count,
        notes=data.notes,
    )
    await db.commit()
    return {"ok": True}


@router.delete("/memory")
async def clear_memory(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """清空我的全部个性化记忆（画像 + 情景事件）。"""
    profile = await db.get(mem_mod.UserProfile, current_user.id)
    if profile:
        await db.delete(profile)
    await db.execute(
        delete(mem_mod.UserMemoryEpisode).where(
            mem_mod.UserMemoryEpisode.user_id == current_user.id
        )
    )
    await db.commit()
    return {"deleted": True}
