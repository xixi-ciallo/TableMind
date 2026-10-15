"""仪表盘统计：全部来自数据库真实聚合，无数据时返回空数组（不使用占位假数据）。"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import cast, func, select
from sqlalchemy.dialects.postgresql import DATE
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.board_game import BoardGame
from app.models.chat import ChatMessage
from app.models.game_tag import GameTag
from app.models.post import Post
from app.models.review import Review
from app.models.user import User
from app.schemas.admin import (
    DailyPoint,
    GameCompleteness,
    GamePoint,
    RatingPoint,
    SeriesPoint,
    StatsOut,
    TagPoint,
)

router = APIRouter()

DEFAULT_DAYS = 14

# 趋势序列：字段名 -> 数据源模型与时间列（以及可选的额外过滤条件）
SERIES_SPECS = [
    ("users", User, User.created_at, None),
    ("reviews", Review, Review.created_at, (Review.content.is_not(None), Review.content != "")),
    ("posts", Post, Post.created_at, None),
    ("ai_calls", ChatMessage, ChatMessage.created_at, None),
]


def _local_midnight() -> datetime:
    """以服务器本地时区取当天零点作为日轴基准。"""
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


async def _count(db: AsyncSession, model) -> int:
    """单表计数；表不存在等异常时返回 0，避免整接口 500。"""
    try:
        res = await db.execute(select(func.count()).select_from(model))
        return int(res.scalar() or 0)
    except Exception:
        await db.rollback()
        return 0


async def _review_count(db: AsyncSession) -> int:
    """评测数：只统计写了正文（content 非空）的评测；纯评分不计入评测数。"""
    try:
        res = await db.execute(
            select(func.count())
            .select_from(Review)
            .where(Review.content.is_not(None), Review.content != "")
        )
        return int(res.scalar() or 0)
    except Exception:
        await db.rollback()
        return 0


async def _daily_series(db: AsyncSession, start: datetime, days: int):
    """
    四张表按天计数后，拼到同一条日轴上。

    先铺出 start..today 共 days 天的日期轴（缺口补 0），
    再逐表聚合回填 —— 单张表查询失败只影响该条曲线，不会让整接口 500。
    """
    axis = [(start + timedelta(days=i)).date().isoformat() for i in range(days)]
    series = {d: {key: 0 for key, _, _, _ in SERIES_SPECS} for d in axis}

    for key, _model, col, _extra in SERIES_SPECS:
        try:
            stmt = (
                select(cast(col, DATE).label("day"), func.count().label("cnt"))
                .where(col >= start)
            )
            if _extra:
                stmt = stmt.where(*_extra)
            stmt = stmt.group_by(cast(col, DATE))
            for day, cnt in (await db.execute(stmt)).all():
                raw = day.isoformat() if hasattr(day, "isoformat") else str(day)
                if raw in series:
                    series[raw][key] = int(cnt or 0)
        except Exception:
            await db.rollback()
    return series


async def _top_games(db: AsyncSession, limit: int = 8):
    """评分榜：只取有真实评分的桌游；一个评分都没有时返回空数组。"""
    try:
        stmt = (
            select(
                BoardGame.id,
                BoardGame.name,
                BoardGame.cover_image,
                BoardGame.avg_rating,
                BoardGame.rating_count,
            )
            .where(BoardGame.rating_count > 0)
            .order_by(BoardGame.avg_rating.desc(), BoardGame.rating_count.desc())
            .limit(limit)
        )
        rows = (await db.execute(stmt)).all()
        return [
            {
                "id": r[0],
                "name": r[1],
                "cover_image": r[2],
                "avg_rating": round(float(r[3] or 0), 2),
                "rating_count": int(r[4] or 0),
            }
            for r in rows
        ]
    except Exception:
        await db.rollback()
        return []


async def _rating_distribution(db: AsyncSession):
    """本站玩家评分分布（1~10 分每档的评测条数）。"""
    try:
        stmt = select(Review.rating, func.count()).group_by(Review.rating).order_by(Review.rating)
        rows = (await db.execute(stmt)).all()
        return [{"rating": int(r[0]), "count": int(r[1] or 0)} for r in rows]
    except Exception:
        await db.rollback()
        return []


async def _tag_usage(db: AsyncSession, limit: int = 10):
    """标签使用量：game_tags 记录 × board_games JSONB 中真实引用次数。"""
    try:
        tags = (await db.execute(select(GameTag))).scalars().all()
        rows = (await db.execute(select(BoardGame.categories, BoardGame.mechanics))).all()

        counter: dict[str, int] = {}
        for cats, mechs in rows:
            for bucket in (cats or [], mechs or []):
                for name in bucket:
                    counter[name] = counter.get(name, 0) + 1

        out = [{"name": t.name, "type": t.type, "usage_count": counter.get(t.name, 0)} for t in tags]
        out.sort(key=lambda x: (-x["usage_count"], x["name"]))
        return out[:limit]
    except Exception:
        await db.rollback()
        return []


@router.get("", response_model=StatsOut)
async def get_stats(
    days: int = Query(DEFAULT_DAYS, ge=2, le=60),
    db: AsyncSession = Depends(get_db),
):
    """仪表盘统计：基础计数 + 供前端图表消费的真实序列。"""
    start = _local_midnight() - timedelta(days=days - 1)

    return StatsOut(
        user_count=await _count(db, User),
        game_count=await _count(db, BoardGame),
        review_count=await _review_count(db),
        post_count=await _count(db, Post),
        ai_call_count=await _count(db, ChatMessage),
        days=days,
        series=[SeriesPoint(date=d, values=v) for d, v in sorted((await _daily_series(db, start, days)).items())],
        top_games=[GamePoint(**g) for g in await _top_games(db)],
        rating_distribution=[RatingPoint(**r) for r in await _rating_distribution(db)],
        tag_usage=[TagPoint(**t) for t in await _tag_usage(db)],
    )


@router.get("/daily", response_model=list[DailyPoint])
async def get_daily(
    days: int = Query(DEFAULT_DAYS, ge=2, le=60),
    db: AsyncSession = Depends(get_db),
):
    """按天序列（供趋势图直接消费）。"""
    start = _local_midnight() - timedelta(days=days - 1)
    data = await _daily_series(db, start, days)
    return [DailyPoint(date=d, **v) for d, v in sorted(data.items())]


# 完整度权重：字段名 -> (权重, 缺失时展示的中文说明)
COMPLETENESS_RULES: list[tuple[str, int, str]] = [
    ("description", 20, "缺中文简介"),
    ("cover_image", 12, "缺封面图"),
    ("players", 14, "缺适用人数"),
    ("categories", 10, "缺分类标签"),
    ("mechanics", 10, "缺机制标签"),
    ("description_en", 8, "缺英文原始简介"),
    ("play_time_minutes", 8, "缺游戏时长"),
    ("publisher", 6, "缺出版社"),
    ("year_published", 5, "缺发行年份"),
    ("min_age", 4, "缺最低年龄"),
    ("complexity", 3, "缺复杂度"),
]


@router.get("/completeness", response_model=list[GameCompleteness])
async def get_completeness(
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """桌游资料完整度体检：按加权得分升序返回，最需要补全的排在最前。"""
    rows = (await db.execute(select(BoardGame).order_by(BoardGame.id))).scalars().all()

    scored: list[GameCompleteness] = []
    for g in rows:
        filled = {
            "description": bool((g.description or "").strip()),
            "cover_image": bool((g.cover_image or "").strip()),
            "players": g.min_players is not None and g.max_players is not None,
            "categories": bool(g.categories),
            "mechanics": bool(g.mechanics),
            "description_en": bool((g.description_en or "").strip()),
            "play_time_minutes": g.play_time_minutes is not None,
            "publisher": bool((g.publisher or "").strip()),
            "year_published": g.year_published is not None,
            "min_age": g.min_age is not None,
            "complexity": g.complexity is not None,
        }
        missing = [label for key, _w, label in COMPLETENESS_RULES if not filled.get(key)]
        score = sum(w for key, w, _l in COMPLETENESS_RULES if filled.get(key))
        scored.append(
            GameCompleteness(id=g.id, name=g.name, score=score, missing=missing)
        )

    scored.sort(key=lambda x: (x.score, x.id))
    return scored[:limit]
