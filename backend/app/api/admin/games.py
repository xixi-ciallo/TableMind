"""管理员端桌游管理：真实的增删改查，全部落库。"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.board_game import BoardGame
from app.models.review import Review
from app.models.rule_document import RuleDocument
from app.schemas.admin import AdminGameOut, GameListOut
from app.schemas.game import GameCreate, GameUpdate

router = APIRouter()

# 排序：与公开接口保持一致，另加后台常用的「按 ID / 按年份 / 按评分」
SORTS = {
    "id": (BoardGame.id.asc(),),
    "-id": (BoardGame.id.desc(),),
    "name": (BoardGame.name.asc(),),
    "-avg_rating": (BoardGame.avg_rating.desc(), BoardGame.rating_count.desc()),
    "avg_rating": (BoardGame.avg_rating.asc(),),
    "-year_published": (BoardGame.year_published.desc(),),
    "year_published": (BoardGame.year_published.asc(),),
    "rating": (BoardGame.avg_rating.desc(), BoardGame.rating_count.desc()),
}


def _apply(data: dict, game: BoardGame) -> None:
    """只覆盖显式提供的字段（GameUpdate 未提供的保持原值）。"""
    for k, v in data.items():
        if v is not None:
            setattr(game, k, v)


def _is_incomplete(game: BoardGame) -> bool:
    """资料是否残缺：缺封面、简介、人数或时长任一即视为不完整。"""
    return not (
        game.cover_image
        and (game.description or "").strip()
        and game.min_players is not None
        and game.max_players is not None
        and game.play_time_minutes is not None
    )


@router.get("", response_model=GameListOut)
async def list_games(
    q: str | None = None,
    sort: str = "id",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    only_incomplete: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """管理员端桌游列表（关键字搜索 / 排序 / 分页，返回真实总数）。"""
    where = []
    if q:
        kw = f"%{q}%"
        where.append(or_(BoardGame.name.ilike(kw), BoardGame.name_en.ilike(kw)))
    if only_incomplete:
        where.append(
            or_(
                BoardGame.cover_image.is_(None),
                BoardGame.cover_image == "",
                BoardGame.description.is_(None),
                BoardGame.description == "",
                BoardGame.min_players.is_(None),
                BoardGame.max_players.is_(None),
                BoardGame.play_time_minutes.is_(None),
            )
        )

    total = (
        await db.execute(
            select(func.count(BoardGame.id)).where(*where) if where
            else select(func.count(BoardGame.id))
        )
    ).scalar() or 0

    # 过滤条件下推到 SQL，不把全表捞到应用层再筛
    incomplete = (
        await db.execute(
            select(func.count(BoardGame.id)).where(
                or_(
                    BoardGame.cover_image.is_(None),
                    BoardGame.cover_image == "",
                    BoardGame.description.is_(None),
                    BoardGame.description == "",
                    BoardGame.min_players.is_(None),
                    BoardGame.max_players.is_(None),
                    BoardGame.play_time_minutes.is_(None),
                )
            )
        )
    ).scalar() or 0

    stmt = select(BoardGame)
    if where:
        stmt = stmt.where(*where)
    stmt = (
        stmt.order_by(*(SORTS.get(sort) or SORTS["id"]))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()

    # 本页桌游的规则文档切片数：一次聚合查询，避免逐条查
    ids = [r.id for r in rows]
    chunk_map: dict[int, int] = {}
    if ids:
        chunk_rows = (
            await db.execute(
                select(RuleDocument.game_id, func.count(RuleDocument.id))
                .where(RuleDocument.game_id.in_(ids))
                .group_by(RuleDocument.game_id)
            )
        ).all()
        chunk_map = {int(gid): int(cnt) for gid, cnt in chunk_rows}

    items = []
    for r in rows:
        item = AdminGameOut.model_validate(r)
        item.rule_chunk_count = chunk_map.get(r.id, 0)
        items.append(item)

    return GameListOut(total=int(total), items=items, incomplete=int(incomplete))


@router.get("/{game_id}", response_model=AdminGameOut)
async def get_game(game_id: int, db: AsyncSession = Depends(get_db)):
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    chunks = (
        await db.execute(
            select(func.count(RuleDocument.id)).where(RuleDocument.game_id == game_id)
        )
    ).scalar() or 0
    out = AdminGameOut.model_validate(game)
    out.rule_chunk_count = int(chunks)
    return out


@router.post("", response_model=AdminGameOut, status_code=201)
async def create_game(data: GameCreate, db: AsyncSession = Depends(get_db)):
    dup = (
        await db.execute(select(BoardGame).where(BoardGame.name == data.name))
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(409, "同名桌游已存在")
    if data.bgg_id is not None:
        dup_bgg = (
            await db.execute(
                select(BoardGame).where(BoardGame.bgg_id == data.bgg_id)
            )
        ).scalar_one_or_none()
        if dup_bgg:
            raise HTTPException(409, f"BGG ID {data.bgg_id} 已被「{dup_bgg.name}」占用")

    game = BoardGame(**data.model_dump())
    db.add(game)
    await db.commit()
    await db.refresh(game)
    return AdminGameOut.model_validate(game)


@router.put("/{game_id}", response_model=AdminGameOut)
async def update_game(
    game_id: int, data: GameUpdate, db: AsyncSession = Depends(get_db)
):
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    if data.bgg_id is not None and data.bgg_id != game.bgg_id:
        dup_bgg = (
            await db.execute(
                select(BoardGame).where(
                    BoardGame.bgg_id == data.bgg_id, BoardGame.id != game_id
                )
            )
        ).scalar_one_or_none()
        if dup_bgg:
            raise HTTPException(409, f"BGG ID {data.bgg_id} 已被「{dup_bgg.name}」占用")

    payload = data.model_dump(exclude_unset=True)
    # 允许通过传 null 明确清空可选字段
    payload.update(data.model_dump(exclude_none=True, exclude_unset=False))
    _apply(payload, game)

    await db.commit()
    await db.refresh(game)
    return AdminGameOut.model_validate(game)


@router.delete("/{game_id}")
async def delete_game(game_id: int, db: AsyncSession = Depends(get_db)):
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    # 级联删除该桌游下的关联数据，避免出现孤儿记录
    reviews = (
        await db.execute(select(Review).where(Review.game_id == game_id))
    ).scalars().all()
    for r in reviews:
        await db.delete(r)

    # 规则文档切片：删游戏后 RAG 里不应残留无主说明书
    chunks = (
        await db.execute(select(RuleDocument).where(RuleDocument.game_id == game_id))
    ).scalars().all()
    for c in chunks:
        await db.delete(c)

    await db.delete(game)
    await db.commit()
    return {
        "detail": "已删除",
        "deleted_reviews": len(reviews),
        "deleted_rule_chunks": len(chunks),
    }


@router.post("/{game_id}/recalc-rating", response_model=AdminGameOut)
async def recalc_rating(game_id: int, db: AsyncSession = Depends(get_db)):
    """按本系统真实评测重算该桌游的平均分与评分人数。"""
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    row = (
        await db.execute(
            select(func.avg(Review.rating), func.count(Review.rating)).where(
                Review.game_id == game_id
            )
        )
    ).first()
    avg, cnt = (row or (None, 0))
    game.avg_rating = round(float(avg), 2) if avg is not None else 0.0
    game.rating_count = int(cnt or 0)
    await db.commit()
    await db.refresh(game)
    return AdminGameOut.model_validate(game)
