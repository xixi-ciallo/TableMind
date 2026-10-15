"""玩家评分排行榜。

排序依据一律是**本站玩家评分**在数据库里的真实聚合结果：
  - 默认榜：avg_rating 降序（评分人数不足的会被过滤掉，避免 1 个人打出 10 分就登顶）；
  - 「最多人评」榜：rating_count 降序。
所有分类榜（人数 / 时长 / 年代 / 分类 / 机制）都是先按条件过滤、再按同一套
评分规则排序，绝不使用任何外部评分或估算值。
"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.board_game import BoardGame
from app.models.collection import Collection

router = APIRouter()

# 少于该评分人数的游戏不进入评分榜（避免个别评分造成失真）
MIN_RATINGS = 3

# ── 预置榜单 ─────────────────────────────────────────────
# filter 为可叠加的 SQLAlchemy 条件列表
STATIC_BOARDS: list[dict] = [
    {
        "id": "overall",
        "label": "玩家评分总榜",
        "group": "综合",
        "description": "全部已收录桌游，按本站玩家平均评分从高到低排序。",
        "filters": [],
        "order": "rating",
    },
    {
        "id": "most-rated",
        "label": "最多人评榜",
        "group": "综合",
        "description": "按参与评分的人数排序，反映站内讨论热度。",
        "filters": [],
        "order": "count",
    },
    {
        "id": "players-2",
        "label": "双人对弈榜",
        "group": "按人数",
        "description": "2 人即可开局的作品。",
        "filters": [BoardGame.min_players <= 2],
        "order": "rating",
    },
    {
        "id": "players-3-4",
        "label": "3-4 人局榜",
        "group": "按人数",
        "description": "最适合 3 到 4 人同乐的作品。",
        "filters": [BoardGame.min_players <= 3, BoardGame.max_players >= 4],
        "order": "rating",
    },
    {
        "id": "players-5plus",
        "label": "5 人以上聚会榜",
        "group": "按人数",
        "description": "能容纳 5 人及以上，适合朋友聚会。",
        "filters": [BoardGame.max_players >= 5],
        "order": "rating",
    },
    {
        "id": "time-fast",
        "label": "30 分钟以内",
        "group": "按时长",
        "description": "节奏轻快，随开随玩。",
        "filters": [BoardGame.play_time_minutes <= 30],
        "order": "rating",
    },
    {
        "id": "time-medium",
        "label": "30-60 分钟",
        "group": "按时长",
        "description": "一局刚好，最常见的时长区间。",
        "filters": [
            BoardGame.play_time_minutes > 30,
            BoardGame.play_time_minutes <= 60,
        ],
        "order": "rating",
    },
    {
        "id": "time-long",
        "label": "1 小时以上",
        "group": "按时长",
        "description": "适合留出整个下午的沉沉浸式对局。",
        "filters": [BoardGame.play_time_minutes > 60],
        "order": "rating",
    },
    {
        "id": "era-classic",
        "label": "经典老牌（2000 年前）",
        "group": "按年代",
        "description": "历经时间检验的经典之作。",
        "filters": [BoardGame.year_published <= 2000],
        "order": "rating",
    },
    {
        "id": "era-modern",
        "label": "近代佳作（2001-2015）",
        "group": "按年代",
        "description": "现代桌游黄金期的代表作品。",
        "filters": [
            BoardGame.year_published >= 2001,
            BoardGame.year_published <= 2015,
        ],
        "order": "rating",
    },
    {
        "id": "era-new",
        "label": "近年新作（2016 及以后）",
        "group": "按年代",
        "description": "近十年出版的新作品。",
        "filters": [BoardGame.year_published >= 2016],
        "order": "rating",
    },
]

# 参与生成分类榜 / 机制榜的标签（按站内出现频率取前若干个）
MAX_TAG_BOARDS = 12


class BoardOut(BaseModel):
    id: str
    label: str
    group: str
    description: str
    game_count: int = 0


class RankingRow(BaseModel):
    rank: int
    game_id: int
    name: str
    name_en: str | None = None
    cover_image: str | None = None
    avg_rating: float
    rating_count: int
    min_players: int | None = None
    max_players: int | None = None
    play_time_minutes: int | None = None
    year_published: int | None = None
    categories: list = []
    mechanics: list = []


class RankingResult(BaseModel):
    board: str
    label: str
    description: str
    min_ratings: int
    total: int
    rows: list[RankingRow]
    """fallback=True 表示站内评分数不足（没有人达到 min_ratings），
    榜单回落为库内收录顺序展示，如实向前端标注。"""
    fallback: bool = False


def _jsonb_contains(column, value: str):
    """JSONB 数组字段包含某中文标签（categories / mechanics 存中文字符串数组）。

    必须用 JSONB.contains([value])，用 CAST('["x"]' AS JSONB) 会被绑定成
    非预期参数而恒不匹配（实测返回 0 条），故统一走 SQLAlchemy 的 contains。
    """
    return column.contains([value])


async def _tag_counts(db: AsyncSession, column) -> list[str]:
    """统计站内出现次数最多的标签，用于动态生成分类榜 / 机制榜。"""
    rows = (
        await db.execute(
            select(func.jsonb_array_elements_text(column).label("t"))
        )
    ).scalars().all()
    from collections import Counter

    return [t for t, _ in Counter(rows).most_common(MAX_TAG_BOARDS)]


@router.get("/boards", response_model=list[BoardOut])
async def list_boards(db: AsyncSession = Depends(get_db)):
    """列出全部可用榜单（含按分类 / 机制动态生成的榜）。"""
    cats = await _tag_counts(db, BoardGame.categories)
    mecs = await _tag_counts(db, BoardGame.mechanics)

    out: list[BoardOut] = []
    for b in STATIC_BOARDS:
        cnt = (
            await db.execute(
                select(func.count(BoardGame.id)).where(
                    and_(*b["filters"]) if b["filters"] else True,
                    BoardGame.rating_count >= MIN_RATINGS,
                )
            )
        ).scalar() or 0
        out.append(BoardOut(
            id=b["id"], label=b["label"], group=b["group"],
            description=b["description"], game_count=int(cnt),
        ))

    for c in cats:
        cond = _jsonb_contains(BoardGame.categories, c)
        cnt = (
            await db.execute(
                select(func.count(BoardGame.id)).where(
                    cond, BoardGame.rating_count >= MIN_RATINGS
                )
            )
        ).scalar() or 0
        if cnt:
            out.append(BoardOut(id=f"cat:{c}", label=f"{c}榜", group="按类型",
                                description=f"分类为「{c}」的桌游，按本站玩家评分排序。",
                                game_count=int(cnt)))

    for m in mecs:
        cond = _jsonb_contains(BoardGame.mechanics, m)
        cnt = (
            await db.execute(
                select(func.count(BoardGame.id)).where(
                    cond, BoardGame.rating_count >= MIN_RATINGS
                )
            )
        ).scalar() or 0
        if cnt:
            out.append(BoardOut(id=f"mec:{m}", label=f"{m}榜", group="按机制",
                                description=f"包含「{m}」机制的桌游，按本站玩家评分排序。",
                                game_count=int(cnt)))
    return out


class PopularRow(BaseModel):
    rank: int
    game_id: int
    name: str
    name_en: str | None = None
    cover_image: str | None = None
    want_count: int
    played_count: int
    avg_rating: float
    rating_count: int


class PopularResult(BaseModel):
    """热门榜结果。fallback=True 表示站内还没有任何想玩/玩过标记，
    榜单按库内收录顺序展示（ counts 全为 0），如实向前端标注。"""

    fallback: bool = False
    rows: list[PopularRow]


@router.get("/popular", response_model=PopularResult)
async def popular_ranking(
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """热门榜：按本站玩家标记的「想玩 + 玩过」数量降序排列。

    全部来自 collections 表的真实标记聚合，不做任何估算；
    站内还没有任何标记时回落为库内收录顺序（fallback=True）。
    """
    counts = (
        select(
            Collection.game_id.label("game_id"),
            func.count().filter(Collection.status == "want").label("want"),
            func.count().filter(Collection.status == "played").label("played"),
        )
        .group_by(Collection.game_id)
        .subquery()
    )
    total = func.coalesce(counts.c.want, 0) + func.coalesce(counts.c.played, 0)
    stmt = (
        select(BoardGame, func.coalesce(counts.c.want, 0), func.coalesce(counts.c.played, 0))
        .join(counts, counts.c.game_id == BoardGame.id, isouter=True)
        .order_by(
            total.desc(),
            func.coalesce(counts.c.played, 0).desc(),
            func.coalesce(counts.c.want, 0).desc(),
            BoardGame.id.asc(),
        )
        .limit(limit)
    )
    rows_res = await db.execute(stmt)

    out: list[PopularRow] = []
    for i, (g, want, played) in enumerate(rows_res.all(), start=1):
        out.append(PopularRow(
            rank=i,
            game_id=g.id,
            name=g.name,
            name_en=g.name_en,
            cover_image=g.cover_image,
            want_count=int(want or 0),
            played_count=int(played or 0),
            avg_rating=round(float(g.avg_rating or 0), 2),
            rating_count=int(g.rating_count or 0),
        ))
    fallback = all(r.want_count + r.played_count == 0 for r in out)
    return PopularResult(fallback=fallback, rows=out)


@router.get("", response_model=RankingResult)
async def get_ranking(
    board: str = Query("overall"),
    limit: int = Query(20, ge=1, le=100),
    min_ratings: int = Query(MIN_RATINGS, ge=1),
    db: AsyncSession = Depends(get_db),
):
    """取某个榜单的排名数据。"""
    spec = next((b for b in STATIC_BOARDS if b["id"] == board), None)
    if spec:
        label, desc, filters = spec["label"], spec["description"], spec["filters"]
        order = spec["order"]
    elif board.startswith("cat:"):
        tag = board[4:]
        label, desc = f"{tag}榜", f"分类为「{tag}」的桌游，按本站玩家评分排序。"
        filters = [_jsonb_contains(BoardGame.categories, tag)]
        order = "rating"
    elif board.startswith("mec:"):
        tag = board[4:]
        label, desc = f"{tag}榜", f"包含「{tag}」机制的桌游，按本站玩家评分排序。"
        filters = [_jsonb_contains(BoardGame.mechanics, tag)]
        order = "rating"
    else:
        from fastapi import HTTPException
        raise HTTPException(404, "榜单不存在")

    base = and_(*filters) if filters else True
    order_key = order

    async def _query(enforce_min: bool):
        cond = and_(base, BoardGame.rating_count >= min_ratings) if enforce_min else base
        if not enforce_min:
            # 兜底排序：没有任何评分时 avg_rating 全为空，稳定按库内收录顺序
            order_cols = [BoardGame.id.asc()]
        else:
            order_cols = [
                BoardGame.rating_count.desc() if order_key == "count" else BoardGame.avg_rating.desc(),
                BoardGame.rating_count.desc(),
                BoardGame.id.asc(),
            ]
        stmt = select(BoardGame).where(cond).order_by(*order_cols).limit(limit)
        return (await db.execute(stmt)).scalars().all()

    games = await _query(True)
    total = (
        await db.execute(
            select(func.count(BoardGame.id)).where(
                base, BoardGame.rating_count >= min_ratings
            )
        )
    ).scalar() or 0

    fallback = False
    if not games:
        # 站内评分不足：回落为库内收录顺序，「随便排」但来源如实标注
        fallback = True
        games = await _query(False)
        total = (
            await db.execute(select(func.count(BoardGame.id)).where(base))
        ).scalar() or 0

    rows = [
        RankingRow(
            rank=i,
            game_id=g.id,
            name=g.name,
            name_en=g.name_en,
            cover_image=g.cover_image,
            avg_rating=round(float(g.avg_rating or 0), 2),
            rating_count=int(g.rating_count or 0),
            min_players=g.min_players,
            max_players=g.max_players,
            play_time_minutes=g.play_time_minutes,
            year_published=g.year_published,
            categories=list(g.categories or []),
            mechanics=list(g.mechanics or []),
        )
        for i, g in enumerate(games, start=1)
    ]
    return RankingResult(
        board=board, label=label, description=desc,
        min_ratings=min_ratings, total=int(total), rows=rows,
        fallback=fallback,
    )
