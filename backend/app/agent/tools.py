"""Agent 可用工具：全部基于本站真实数据查询，不返回任何推断或占位内容。

这些函数同时供大模型（作为回答依据）与站内检索降级路径复用。
"""
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.board_game import BoardGame
from app.models.collection import Collection

# 工具结果会进 prompt，简介需要截断
BRIEF_LEN = 120


def brief(g: BoardGame) -> dict:
    desc = (g.description or "").strip().replace("\n", " ")
    if len(desc) > BRIEF_LEN:
        desc = desc[:BRIEF_LEN] + "…"
    return {
        "id": g.id,
        "name": g.name,
        "name_en": g.name_en,
        "players": f"{g.min_players}-{g.max_players}" if g.min_players and g.max_players else None,
        "play_time": g.play_time_minutes,
        "min_age": g.min_age,
        "complexity": g.complexity,
        "publisher": g.publisher,
        "year": g.year_published,
        "categories": list(g.categories or []),
        "mechanics": list(g.mechanics or []),
        "description": desc or None,
    }


async def search_games(
    db: AsyncSession,
    keywords: str | None = None,
    min_players: int | None = None,
    max_players: int | None = None,
    play_time: int | None = None,
    play_time_min: int | None = None,
    complexity: float | None = None,
    category: str | None = None,
    mechanic: str | None = None,
    limit: int = 8,
) -> list[dict]:
    """工具：按条件查询桌游库。

    人数语义为「区间相交」：min_players 表示至少要能容纳这么多人
    （game.max_players >= min_players）；max_players 表示这么多人也能开
    （game.min_players <= max_players）。
    时长分上下限：play_time 是上限（≤），play_time_min 是下限（≥）——
    「想找 1 小时以上」必须走下限，否则会把 30 分钟的轻量游戏推给想要长局的人。
    """
    q = select(BoardGame)
    if keywords:
        kw = f"%{keywords.strip()}%"
        q = q.where(
            or_(
                BoardGame.name.ilike(kw),
                BoardGame.name_en.ilike(kw),
                BoardGame.publisher.ilike(kw),
            )
        )
    if min_players is not None:
        q = q.where(BoardGame.max_players >= min_players)
    if max_players is not None:
        q = q.where(BoardGame.min_players <= max_players)
    if play_time is not None:
        q = q.where(BoardGame.play_time_minutes <= play_time)
    if play_time_min is not None:
        q = q.where(BoardGame.play_time_minutes >= play_time_min)
    if complexity is not None:
        # 休眠护栏：board_games.complexity 当前多为 null（缺真实数据），
        # 若全库没有非空复杂度，过滤会返回空集把推荐清空——此时跳过该条件，避免破坏推荐。
        any_c = await db.scalar(
            select(func.count())
            .select_from(BoardGame)
            .where(BoardGame.complexity.isnot(None))
        )
        if any_c:
            q = q.where(BoardGame.complexity <= complexity)
    if category:
        q = q.where(cast(BoardGame.categories, String).ilike(f"%{category}%"))
    if mechanic:
        q = q.where(cast(BoardGame.mechanics, String).ilike(f"%{mechanic}%"))

    rows = (await db.execute(q.order_by(BoardGame.id).limit(limit))).scalars().all()
    return [brief(g) for g in rows]


async def get_game_detail(db: AsyncSession, game_id: int) -> dict | None:
    """工具：查询某款桌游的完整资料（简介不截断）。"""
    g = await db.get(BoardGame, game_id)
    if not g:
        return None
    detail = brief(g)
    detail["description"] = (g.description or "").strip() or None
    return detail


async def get_user_collection(db: AsyncSession, user_id: int) -> list[dict]:
    """工具：查询当前用户的收藏清单（want / played / owned），避免重复推荐。"""
    rows = (
        await db.execute(
            select(Collection, BoardGame.name)
            .join(BoardGame, BoardGame.id == Collection.game_id)
            .where(Collection.user_id == user_id)
            .order_by(Collection.id)
        )
    ).all()
    return [
        {"game_id": c.game_id, "name": name, "status": c.status} for c, name in rows
    ]


async def random_picks(db: AsyncSession, limit: int = 5) -> list[dict]:
    """工具：站内真实收录的随机若干款，用于没有明确条件的「随便推荐」。"""
    rows = (await db.execute(select(BoardGame).order_by(func.random()).limit(limit))).scalars().all()
    return [brief(g) for g in rows]
