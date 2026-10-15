from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.post import CommentCreate, CommentOut

router = APIRouter()


@router.get("", response_model=list[CommentOut])
async def list_comments(post_id: int):
    """评论列表 —— 占位"""
    return []


@router.post("", response_model=CommentOut)
async def create_comment(
    data: CommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """发表评论/回复 —— 占位"""
    return {
        "id": 1,
        "post_id": 1,
        "user_id": current_user.id,
        "parent_id": data.parent_id,
        "content": data.content,
        "created_at": "2024-01-01T00:00:00",
    }
