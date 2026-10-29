"""用户记忆层（个性化）：与 RAG 语义记忆分开存、分开取。

分层定位：
- 语义记忆（长期-事实/规则）：RAG 向量库 rule_documents，已在 rag.py 实现，规则问答用。
- 个性化记忆（本项目新增）：
    - 用户画像 UserProfile：每用户一行，蒸馏后的结构化偏好快照。
    - 情景记忆 UserMemoryEpisode：按时间追加的具体交互事件（「用户觉得卡坦岛太重」）。

工程取舍（对应 C4 健壮性 / C5 有界自主）：
- 读取是同步的：推荐前先查画像 + 近期情景，拼成个性化上下文注入 prompt（见 format_personalization）。
- 写入（蒸馏）是 best-effort：任何 LLM / 解析 / DB 异常都吞掉，绝不阻塞用户回复。
- 蒸馏走独立会话（async_session_factory），以 fire-and-forget 后台任务触发，不增加首字延迟。
- 不使用 ChatOpenAI.with_structured_output（该模型偶发 400），改为 chat_complete + 防御性 JSON 解析。
- 没有用「自主 Agent」来做这件事：它本质是「数据存取 + 一次有界 LLM 抽取」，固定流水线更可控、可评测、更省。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import llm
from app.core.config import settings
from app.core.database import async_session_factory
from app.models.user_memory import UserMemoryEpisode, UserProfile

log = logging.getLogger(__name__)

# 容量 / 冲突管理常量
MAX_EPISODES_PER_USER = 200
EP_CAP = 8        # 画像列表类字段保留上限（最近优先）
DISLIKE_CAP = 20
DISTILL_MAX_TOKENS = 600

_KIND_MAP = {"preference": "preference", "feedback": "feedback", "fact": "fact"}


# ───────────────────────── 读取（检索） ─────────────────────────

async def get_profile(db: AsyncSession, user_id: int) -> UserProfile | None:
    """读用户画像（每用户一行，无则 None）。"""
    return await db.get(UserProfile, user_id)


async def get_recent_episodes(
    db: AsyncSession, user_id: int, limit: int = 10
) -> list[UserMemoryEpisode]:
    """读最近的情景事件（按时间倒序取 limit，再翻正序便于拼接）。"""
    rows = (
        await db.execute(
            select(UserMemoryEpisode)
            .where(UserMemoryEpisode.user_id == user_id)
            .order_by(UserMemoryEpisode.id.desc())
            .limit(limit)
        )
    ).scalars().all()
    return list(reversed(rows))


def format_personalization(
    profile: UserProfile | None, episodes: list[UserMemoryEpisode]
) -> str | None:
    """把画像 + 近期情景拼成给模型的个性化上下文（纯文本，便于直接喂 prompt）。"""
    if profile is None and not episodes:
        return None

    lines: list[str] = [
        "【用户画像与历史偏好】（来自你之前与本站的交互，仅供参考，不得编造）"
    ]
    if profile:
        if profile.preferred_categories:
            lines.append(f"- 喜欢的分类：{'、'.join(profile.preferred_categories)}")
        if profile.preferred_mechanics:
            lines.append(f"- 喜欢的机制：{'、'.join(profile.preferred_mechanics)}")
        if profile.disliked_games:
            lines.append(
                f"- 不喜欢这些游戏（尽量避免重复推荐，或说明为何仍推荐）："
                f"{'、'.join(profile.disliked_games)}"
            )
        if profile.preferred_player_count:
            lines.append(f"- 常玩人数：{profile.preferred_player_count} 人")
        if profile.max_complexity is not None:
            lines.append(
                f"- 可接受的复杂度上限约为：{profile.max_complexity}/5"
                f"（本站复杂度数据缺失时仅作软提示，不要据此臆造数值）"
            )
        if profile.notes:
            lines.append(f"- 备注：{profile.notes}")
    if episodes:
        ev = "；".join(e.content for e in episodes[-6:])
        lines.append(f"- 近期交互记录：{ev}")
    lines.append(
        "请在挑选与写理由时尊重这些偏好；若候选无法满足，如实说明，不要为了迎合而编造。"
    )
    return "\n".join(lines)


# ───────────────────────── 写入（管理 / 蒸馏） ─────────────────────────

async def upsert_profile(
    db: AsyncSession,
    user_id: int,
    *,
    categories: list[str] | None = None,
    mechanics: list[str] | None = None,
    disliked_games: list[str] | None = None,
    max_complexity: float | None = None,
    preferred_player_count: int | None = None,
    notes: str | None = None,
) -> UserProfile:
    """合并式更新画像：列表字段去重后保留最近 EP_CAP 个；复杂度取更严格（更小）的上限。"""
    prof = await db.get(UserProfile, user_id)
    if prof is None:
        prof = UserProfile(user_id=user_id)
        db.add(prof)

    if categories is not None:
        merged = list(prof.preferred_categories or [])
        for c in categories:
            if c and c not in merged:
                merged.append(c)
        prof.preferred_categories = merged[-EP_CAP:]
    if mechanics is not None:
        merged = list(prof.preferred_mechanics or [])
        for m in mechanics:
            if m and m not in merged:
                merged.append(m)
        prof.preferred_mechanics = merged[-EP_CAP:]
    if disliked_games is not None:
        merged = list(prof.disliked_games or [])
        for g in disliked_games:
            if g and g not in merged:
                merged.append(g)
        prof.disliked_games = merged[-DISLIKE_CAP:]
    if max_complexity is not None:
        if prof.max_complexity is None or max_complexity < prof.max_complexity:
            prof.max_complexity = max_complexity
    if preferred_player_count is not None:
        prof.preferred_player_count = preferred_player_count
    if notes:
        ts = datetime.now().strftime("%m-%d")
        existing = (prof.notes or "").strip()
        prof.notes = f"{existing}\n[{ts}] {notes}" if existing else f"[{ts}] {notes}"

    prof.updated_at = datetime.now()
    return prof


async def add_episode(
    db: AsyncSession,
    user_id: int,
    content: str,
    *,
    kind: str = "feedback",
    game_name: str | None = None,
) -> UserMemoryEpisode:
    """追加一条情景事件；超过上限时删最旧，避免无限增长。"""
    ep = UserMemoryEpisode(
        user_id=user_id,
        kind=_KIND_MAP.get(kind, "feedback"),
        content=content,
        game_name=game_name,
    )
    db.add(ep)

    count = await db.scalar(
        select(func.count())
        .select_from(UserMemoryEpisode)
        .where(UserMemoryEpisode.user_id == user_id)
    )
    if count and count > MAX_EPISODES_PER_USER:
        overflow = count - MAX_EPISODES_PER_USER
        old_ids = (
            await db.execute(
                select(UserMemoryEpisode.id)
                .where(UserMemoryEpisode.user_id == user_id)
                .order_by(UserMemoryEpisode.id.asc())
                .limit(overflow)
            )
        ).scalars().all()
        for oid in old_ids:
            await db.execute(
                delete(UserMemoryEpisode).where(UserMemoryEpisode.id == oid)
            )
    return ep


# ───────────────────────── 蒸馏（从对话里抽偏好） ─────────────────────────

_DISTILL_SYSTEM = """你是从对话中提取用户桌游偏好的助手。阅读「用户消息」和「AI 回复」，提取关于用户偏好的信号。
只输出一个 JSON 对象，不要输出任何其它文字、不要使用 Markdown 代码块。
字段说明：
- categories：用户明确喜欢的分类（中文，尽量用常见桌游分类，如 策略、合作、家庭、派对、德式、美式）
- mechanics：用户明确喜欢的机制（如 卡牌驱动、区域控制、工人放置）
- disliked_games：用户明确不喜欢或吐槽过的游戏名（名称即可，不需要 id）
- max_complexity：用户表示「太复杂 / 太重 / 太难」时填一个 1-5 的上限，否则填 null
- preferred_player_count：用户常用的游戏人数（整数），否则 null
- episodes：1-3 句具体的交互事件（用于情景记忆，如「用户觉得卡坦岛太重」「用户上周问过璀璨宝石」）
若没有任何偏好信号，全部填空：{"categories":[],"mechanics":[],"disliked_games":[],"max_complexity":null,"preferred_player_count":null,"episodes":[]}"""


def _extract_json(text: str) -> dict | None:
    """从模型输出里尽量抠出 JSON 对象（模型可能用 ```json 包裹或前后带废话）。"""
    if not text:
        return None
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    if not text.startswith("{"):
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        text = m.group(0)
    try:
        return json.loads(text)
    except ValueError:
        return None


async def distill_from_exchange(user_id: int, message: str, reply: str) -> None:
    """蒸馏写入（best-effort）：从一轮对话里提取偏好，落到画像与情景记忆。

    在独立会话里跑，任何异常都吞掉——绝不影响主回复。失败只记 warning 日志。
    """
    try:
        if not llm.available():
            return

        prompt = [
            {"role": "system", "content": _DISTILL_SYSTEM},
            {"role": "user", "content": f"用户消息：{message}\n\nAI 回复：{reply}"},
        ]
        raw = await llm.chat_complete(
            prompt,
            temperature=0.2,
            max_tokens=DISTILL_MAX_TOKENS,
            model=settings.LLM_FAST_MODEL or settings.LLM_MODEL,
        )
        data = _extract_json(raw)
        if not data:
            return

        cats = [str(x) for x in (data.get("categories") or []) if x]
        mechs = [str(x) for x in (data.get("mechanics") or []) if x]
        dislikes = [str(x) for x in (data.get("disliked_games") or []) if x]
        max_c = data.get("max_complexity")
        try:
            max_c = float(max_c) if max_c is not None else None
        except (TypeError, ValueError):
            max_c = None
        ppc = data.get("preferred_player_count")
        try:
            ppc = int(ppc) if ppc is not None else None
        except (TypeError, ValueError):
            ppc = None
        episodes = [str(x) for x in (data.get("episodes") or []) if x]

        async with async_session_factory() as db:
            if cats or mechs or dislikes or max_c is not None or ppc is not None:
                await upsert_profile(
                    db,
                    user_id,
                    categories=cats,
                    mechanics=mechs,
                    disliked_games=dislikes,
                    max_complexity=max_c,
                    preferred_player_count=ppc,
                )
            for ev in episodes[:3]:
                await add_episode(db, user_id, ev, kind="feedback")
            if cats or mechs or dislikes or episodes:
                await db.commit()
    except Exception as e:  # noqa: BLE001 - 蒸馏失败绝不影响主流程
        log.warning("用户记忆蒸馏失败（已跳过）：%s", e)
