import os
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.core.security import hash_password, verify_password
from app.models.collection import Collection
from app.models.post import Post
from app.models.review import Review
from app.models.user import User
from app.schemas.user import UserOut

router = APIRouter()

# backend/app/uploads（与 main.py 的 /uploads 静态挂载一致）
APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AVATAR_ROOT = os.path.join(APP_DIR, "uploads", "avatars")
MAX_AVATAR_BYTES = 4 * 1024 * 1024  # 头像 4MB
ALLOWED_IMAGE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


class ProfileUpdate(BaseModel):
    username: str = Field(min_length=2, max_length=50)
    bio: str | None = Field(default=None, max_length=500)


class PasswordChange(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6, max_length=128)


@router.get("/stats")
async def my_stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """个人中心统计：收藏按状态分档 + 评测数 + 帖子数，全部为真实聚合。"""
    rows = (
        await db.execute(
            select(Collection.status, func.count(Collection.id))
            .where(Collection.user_id == current_user.id)
            .group_by(Collection.status)
        )
    ).all()
    by_status = {s: int(c) for s, c in rows}

    reviews = (
        await db.execute(
            select(func.count(Review.id)).where(
                Review.user_id == current_user.id,
                Review.content.is_not(None),
                Review.content != "",
            )
        )
    ).scalar() or 0
    posts = (
        await db.execute(select(func.count(Post.id)).where(Post.user_id == current_user.id))
    ).scalar() or 0

    return {
        "want": by_status.get("want", 0),
        "played": by_status.get("played", 0),
        "owned": by_status.get("owned", 0),
        "reviews": int(reviews),
        "posts": int(posts),
    }


@router.patch("/profile", response_model=UserOut)
async def update_profile(
    data: ProfileUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改昵称与个人简介（登录凭证仍是手机号，昵称只作展示）。"""
    name = data.username.strip()
    if not name:
        raise HTTPException(status_code=400, detail="昵称不能为空")
    dup = (
        await db.execute(select(User).where(User.username == name, User.id != current_user.id))
    ).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=400, detail="该昵称已被占用")

    current_user.username = name
    current_user.bio = (data.bio or "").strip() or None
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.post("/avatar", response_model=UserOut)
async def upload_avatar(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上传头像：jpg/png/webp/gif，≤4MB，服务端生成文件名（不接受客户端文件名）。"""
    ctype = (file.content_type or "").lower()
    ext = ALLOWED_IMAGE.get(ctype)
    if not ext:
        raise HTTPException(status_code=400, detail="只支持 jpg / png / webp / gif 图片")

    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(body) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=400, detail="头像不能超过 4MB")

    user_dir = os.path.join(AVATAR_ROOT, str(current_user.id))
    os.makedirs(user_dir, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(user_dir, filename), "wb") as fp:
        fp.write(body)

    current_user.avatar = f"/uploads/avatars/{current_user.id}/{filename}"
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.post("/password")
async def change_password(
    data: PasswordChange,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改密码：需校验原密码。"""
    if not verify_password(data.old_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="原密码不正确")

    current_user.password_hash = hash_password(data.new_password)
    await db.commit()
    return {"detail": "密码已修改，下次登录请使用新密码"}
