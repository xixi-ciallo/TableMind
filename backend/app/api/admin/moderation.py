"""管理员端内容审核：评测 / 帖子 / 评论的真实列表与删除。

删除评测后会按剩余真实评测重算该桌游的平均分，避免榜单残留脏数据。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.board_game import BoardGame
from app.models.comment import Comment
from app.models.post import Post
from app.models.review import Review
from app.models.user import User

router = APIRouter()


async def _recalc_game_rating(db: AsyncSession, game_id: int | None) -> None:
    if not game_id:
        return
    game = await db.get(BoardGame, game_id)
    if not game:
        return
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


@router.get("/reviews")
async def list_reviews(
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    stmt = (
        select(
            Review.id,
            Review.user_id,
            Review.game_id,
            Review.rating,
            Review.content,
            Review.created_at,
            User.username.label("username"),
            BoardGame.name.label("game_name"),
        )
        .join(User, User.id == Review.user_id)
        .outerjoin(BoardGame, BoardGame.id == Review.game_id)
        .where(Review.content.is_not(None), Review.content != "")
        .order_by(Review.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "username": r.username,
            "game_id": r.game_id,
            "game_name": r.game_name,
            "rating": r.rating,
            "content": r.content,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.delete("/reviews/{review_id}")
async def delete_review(review_id: int, db: AsyncSession = Depends(get_db)):
    review = await db.get(Review, review_id)
    if not review:
        raise HTTPException(404, "评测不存在")

    game_id = review.game_id
    await db.delete(review)
    await _recalc_game_rating(db, game_id)
    await db.commit()
    return {"detail": "已删除"}


@router.get("/posts")
async def list_posts(
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    stmt = (
        select(
            Post.id,
            Post.user_id,
            Post.game_id,
            Post.title,
            Post.content,
            Post.created_at,
            User.username.label("username"),
            BoardGame.name.label("game_name"),
        )
        .join(User, User.id == Post.user_id)
        .outerjoin(BoardGame, BoardGame.id == Post.game_id)
        .order_by(Post.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "username": r.username,
            "game_id": r.game_id,
            "game_name": r.game_name,
            "title": r.title,
            "content": r.content,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.delete("/posts/{post_id}")
async def delete_post(post_id: int, db: AsyncSession = Depends(get_db)):
    post = await db.get(Post, post_id)
    if not post:
        raise HTTPException(404, "帖子不存在")

    # 帖子下的评论一并删除，避免出现孤儿评论
    comments = (
        await db.execute(select(Comment).where(Comment.post_id == post_id))
    ).scalars().all()
    for c in comments:
        await db.delete(c)

    await db.delete(post)
    await db.commit()
    return {"detail": "已删除", "deleted_comments": len(comments)}


@router.get("/comments")
async def list_comments(
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    stmt = (
        select(
            Comment.id,
            Comment.post_id,
            Comment.user_id,
            Comment.content,
            Comment.created_at,
            User.username.label("username"),
            Post.title.label("post_title"),
        )
        .join(User, User.id == Comment.user_id)
        .outerjoin(Post, Post.id == Comment.post_id)
        .order_by(Comment.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).all()
    return [
        {
            "id": r.id,
            "post_id": r.post_id,
            "post_title": r.post_title,
            "user_id": r.user_id,
            "username": r.username,
            "content": r.content,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.delete("/comments/{comment_id}")
async def delete_comment(comment_id: int, db: AsyncSession = Depends(get_db)):
    comment = await db.get(Comment, comment_id)
    if not comment:
        raise HTTPException(404, "评论不存在")

    await db.delete(comment)
    await db.commit()
    return {"detail": "已删除"}
