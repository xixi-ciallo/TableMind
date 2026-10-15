from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.board_game import BoardGame
from app.models.collection import Collection
from app.models.user import User
from app.schemas.collection import CollectionCreate, CollectionOut, CollectionUpdate

router = APIRouter()

VALID_STATUS = "^(want|played|owned)$"


def _out(c: Collection, name: str | None, cover: str | None) -> dict:
    """组装返回体：基础字段来自收藏记录，游戏名/封面来自关联桌游。"""
    data = CollectionOut.model_validate(c).model_dump()
    data["game_name"] = name
    data["cover_image"] = cover
    return data


@router.get("", response_model=list[CollectionOut])
async def list_collections(
    status: str | None = Query(None, pattern=VALID_STATUS),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """我的收藏列表（可按 status 过滤），按加入时间倒序。"""
    stmt = (
        select(Collection, BoardGame.name, BoardGame.cover_image)
        .outerjoin(BoardGame, BoardGame.id == Collection.game_id)
        .where(Collection.user_id == current_user.id)
    )
    if status:
        stmt = stmt.where(Collection.status == status)
    rows = (await db.execute(stmt.order_by(Collection.id.desc()))).all()
    return [_out(c, name, cover) for c, name, cover in rows]


@router.post("", response_model=CollectionOut)
async def create_collection(
    data: CollectionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """添加收藏。同一款游戏重复提交视为修改状态（user+game 唯一），不产生重复行。"""
    game = await db.get(BoardGame, data.game_id)
    if not game:
        raise HTTPException(status_code=404, detail="桌游不存在")

    existing = (
        await db.execute(
            select(Collection).where(
                Collection.user_id == current_user.id,
                Collection.game_id == data.game_id,
            )
        )
    ).scalar_one_or_none()

    if existing:
        existing.status = data.status
        target = existing
    else:
        target = Collection(
            user_id=current_user.id,
            game_id=data.game_id,
            status=data.status,
        )
        db.add(target)
    await db.commit()
    await db.refresh(target)
    return _out(target, game.name, game.cover_image)


@router.put("/{collection_id}", response_model=CollectionOut)
async def update_collection(
    collection_id: int,
    data: CollectionUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改收藏状态：只能改自己的记录。"""
    c = await db.get(Collection, collection_id)
    if not c or c.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="收藏记录不存在")
    c.status = data.status
    await db.commit()
    await db.refresh(c)

    game = await db.get(BoardGame, c.game_id)
    return _out(c, game.name if game else None, game.cover_image if game else None)


@router.delete("/{collection_id}")
async def delete_collection(
    collection_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取消收藏：只能删自己的记录。"""
    c = await db.get(Collection, collection_id)
    if not c or c.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="收藏记录不存在")
    await db.delete(c)
    await db.commit()
    return {"detail": "已取消收藏"}
