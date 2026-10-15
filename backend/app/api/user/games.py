"""桌游公开接口：真实读取数据库（含本站玩家评分聚合结果）。"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import asc, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.api.admin.rule_books import _to_out
from app.models.board_game import BoardGame
from app.models.rule_book import RuleBook
from app.schemas.admin import RuleBookOut
from app.schemas.game import GameOut

router = APIRouter()

SORTS = {
    "-avg_rating": (desc(BoardGame.avg_rating), desc(BoardGame.rating_count)),
    "avg_rating": (asc(BoardGame.avg_rating),),
    "-year_published": (desc(BoardGame.year_published),),
    "year_published": (asc(BoardGame.year_published),),
    "-rating_count": (desc(BoardGame.rating_count),),
    "name": (asc(BoardGame.name),),
    "id": (asc(BoardGame.id),),
}


@router.get("", response_model=list[GameOut])
async def list_games(
    q: Annotated[str | None, Query(description="关键词（中文名 / 英文名）")] = None,
    min_players: int | None = Query(None, ge=1),
    max_players: int | None = Query(None, ge=1),
    play_time: int | None = Query(None, description="最长游戏时长（分钟）上限"),
    category: str | None = Query(None, description="分类标签（站内中文标签）"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort: str = Query("id"),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(BoardGame)

    if q:
        kw = f"%{q}%"
        stmt = stmt.where(or_(BoardGame.name.ilike(kw), BoardGame.name_en.ilike(kw)))
    if min_players is not None:
        # 能容纳至少 min_players 人
        stmt = stmt.where(BoardGame.max_players >= min_players)
    if max_players is not None:
        # 人数上限不超过 max_players
        stmt = stmt.where(BoardGame.min_players <= max_players)
    if play_time is not None:
        stmt = stmt.where(BoardGame.play_time_minutes <= play_time)
    if category:
        stmt = stmt.where(BoardGame.categories.contains([category]))

    order = SORTS.get(sort) or SORTS["id"]
    stmt = stmt.order_by(*order).offset((page - 1) * page_size).limit(page_size)

    return (await db.execute(stmt)).scalars().all()


@router.get("/{game_id}/rule-books", response_model=list[RuleBookOut])
async def get_game_rule_books(game_id: int, db: AsyncSession = Depends(get_db)):
    """前台翻阅用：该桌游的规则书原文件（PDF 可内嵌预览，图片按页返回）。

    只返回已登记的规则书，没有则为空列表——前端据此显示「暂无规则书」，不编造。
    """
    rows = (
        await db.execute(
            select(RuleBook).where(RuleBook.game_id == game_id).order_by(RuleBook.id)
        )
    ).scalars().all()
    return [await _to_out(db, b, with_pages=True) for b in rows]


@router.get("/{game_id}", response_model=GameOut)
async def get_game(game_id: int, db: AsyncSession = Depends(get_db)):
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")
    return game
