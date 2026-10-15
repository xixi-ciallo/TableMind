"""管理员端用户管理：真实列表、搜索、启用/禁用与角色调整。"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.collection import Collection
from app.models.post import Post
from app.models.review import Review
from app.models.user import User
from app.schemas.admin import AdminUserDetail, UserListOut
from app.schemas.user import UserOut

router = APIRouter()

VALID_ROLES = ("user", "admin")


async def _activity(db: AsyncSession, user_id: int) -> dict:
    """该用户在本站的真实产出条数（评测 / 帖子 / 收藏）。"""

    async def count(model, col) -> int:
        res = await db.execute(
            select(func.count(model.id)).where(col == user_id)
        )
        return int(res.scalar() or 0)

    # 评测数只统计写了正文的评测；纯评分（content 为空）不计入
    review_cnt = await db.execute(
        select(func.count(Review.id)).where(
            Review.user_id == user_id,
            Review.content.is_not(None),
            Review.content != "",
        )
    )
    review_count = int(review_cnt.scalar() or 0)

    return {
        "review_count": review_count,
        "post_count": await count(Post, Post.user_id),
        "collection_count": await count(Collection, Collection.user_id),
    }


@router.get("", response_model=UserListOut)
async def list_users(
    q: str | None = None,
    role: str | None = Query(None, description="按角色过滤：user / admin"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """用户列表：返回真实总数，支持关键字搜索与角色过滤。"""
    where = []
    if q:
        kw = f"%{q}%"
        where.append(or_(User.username.ilike(kw), User.phone.ilike(kw)))
    if role in VALID_ROLES:
        where.append(User.role == role)

    total = (
        await db.execute(
            select(func.count(User.id)).where(*where) if where
            else select(func.count(User.id))
        )
    ).scalar() or 0

    stmt = select(User)
    if where:
        stmt = stmt.where(*where)
    stmt = (
        stmt.order_by(User.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()

    disabled = (
        await db.execute(
            select(func.count(User.id)).where(User.is_active.is_(False))
        )
    ).scalar() or 0

    return UserListOut(
        total=int(total),
        items=[UserOut.model_validate(r) for r in rows],
        disabled=int(disabled),
    )


@router.get("/{user_id}", response_model=AdminUserDetail)
async def get_user(user_id: int, db: AsyncSession = Depends(get_db)):
    """用户详情：基础资料 + 在该站的真实产出条数。"""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    return AdminUserDetail(
        **UserOut.model_validate(user).model_dump(),
        **await _activity(db, user_id),
    )


@router.put("/{user_id}/status", response_model=UserOut)
async def set_user_status(
    user_id: int,
    is_active: bool,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """启用 / 禁用账号；不允许把自己禁用，避免把自己锁在后台外面。"""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    if user.id == current.id and not is_active:
        raise HTTPException(400, "不能禁用当前登录的管理员账号")

    user.is_active = is_active
    await db.commit()
    await db.refresh(user)
    return UserOut.model_validate(user)


@router.put("/{user_id}/role", response_model=UserOut)
async def set_user_role(
    user_id: int,
    role: str,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """调整角色（user / admin）；不允许撤销自己的管理员身份。"""
    if role not in VALID_ROLES:
        raise HTTPException(400, f"角色只能是 {' / '.join(VALID_ROLES)}")

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "用户不存在")
    if user.id == current.id and role != "admin":
        raise HTTPException(400, "不能撤销自己的管理员身份")

    admin_count = (
        await db.execute(
            select(func.count(User.id)).where(User.role == "admin")
        )
    ).scalar() or 0
    if user.role == "admin" and role != "admin" and admin_count <= 1:
        raise HTTPException(400, "至少保留一名管理员")

    user.role = role
    await db.commit()
    await db.refresh(user)
    return UserOut.model_validate(user)
