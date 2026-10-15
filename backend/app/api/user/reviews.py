"""评测 / 评分：真实读写数据库，评分变化后同步重算桌游均分。

支持三件真实社区行为：附带图片（最多 9 张）、点赞（一人一次）、回复。
"""
import os
import re
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, get_optional_user
from app.models.board_game import BoardGame
from app.models.review import Review, ReviewComment, ReviewLike
from app.models.user import User
from app.schemas.review import (
    RatingSummary,
    ReviewCommentCreate,
    ReviewCommentOut,
    ReviewCreate,
    ReviewImageResult,
    ReviewLikeResult,
    ReviewOut,
)

router = APIRouter()

# 评测图片落盘位置：backend/uploads/reviews/<review_id>/<uuid>.jpg
UPLOAD_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "uploads",
    "reviews",
)
MAX_IMAGES = 9
MAX_BYTES = 5 * 1024 * 1024  # 单张 5MB
ALLOWED_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


async def _recalc(db: AsyncSession, game_id: int) -> None:
    """按真实评测重算某款桌游的平均分与评分人数。"""
    game = await db.get(BoardGame, game_id)
    if not game:
        return
    row = (
        await db.execute(
            select(func.avg(Review.rating), func.count(Review.id)).where(
                Review.game_id == game_id
            )
        )
    ).first()
    avg, cnt = row or (None, 0)
    game.avg_rating = round(float(avg), 2) if avg is not None else 0.0
    game.rating_count = int(cnt or 0)


def _to_out(
    review: Review,
    username: str | None,
    game_name: str | None,
    *,
    comment_count: int = 0,
    liked: bool = False,
) -> ReviewOut:
    return ReviewOut(
        id=review.id,
        user_id=review.user_id,
        game_id=review.game_id,
        rating=review.rating,
        content=review.content,
        like_count=int(review.like_count or 0),
        created_at=review.created_at,
        username=username,
        game_name=game_name,
        images=list(review.images) if review.images else None,
        comment_count=comment_count,
        liked=liked,
    )


@router.get("", response_model=list[ReviewOut])
async def list_reviews(
    game_id: int | None = None,
    mine: bool = False,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    stmt = (
        select(
            Review,
            User.username.label("username"),
            BoardGame.name.label("game_name"),
        )
        .join(User, User.id == Review.user_id)
        .outerjoin(BoardGame, BoardGame.id == Review.game_id)
    )
    if game_id:
        stmt = stmt.where(Review.game_id == game_id)
    if mine:
        # 个人中心「我的评测」：只取当前登录用户自己的评测
        if not current_user:
            raise HTTPException(status_code=401, detail="请先登录")
        stmt = stmt.where(Review.user_id == current_user.id)
    # 评测列表只返回「写了正文」的评测；纯评分（content 为空）只计入评分汇总，不进入列表
    stmt = stmt.where(Review.content.is_not(None), Review.content != "")
    rows = (await db.execute(stmt.order_by(Review.id.desc()).limit(limit))).all()
    if not rows:
        return []

    ids = [r.Review.id for r in rows]

    comment_counts = dict(
        (
            await db.execute(
                select(ReviewComment.review_id, func.count(ReviewComment.id))
                .where(ReviewComment.review_id.in_(ids))
                .group_by(ReviewComment.review_id)
            )
        ).all()
    )

    liked_ids: set[int] = set()
    if current_user:
        liked_ids = set(
            (
                await db.execute(
                    select(ReviewLike.review_id).where(
                        ReviewLike.user_id == current_user.id,
                        ReviewLike.review_id.in_(ids),
                    )
                )
            )
            .scalars()
            .all()
        )

    return [
        _to_out(
            r.Review,
            r.username,
            r.game_name,
            comment_count=int(comment_counts.get(r.Review.id, 0)),
            liked=r.Review.id in liked_ids,
        )
        for r in rows
    ]


@router.get("/summary", response_model=RatingSummary)
async def rating_summary(
    game_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """某款桌游的评分汇总，并附带当前登录用户自己的评分。"""
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    mine = (
        await db.execute(
            select(Review.rating).where(
                Review.game_id == game_id, Review.user_id == current_user.id
            )
        )
    ).scalar()
    return RatingSummary(
        game_id=game_id,
        avg_rating=round(float(game.avg_rating or 0), 2),
        rating_count=int(game.rating_count or 0),
        my_rating=int(mine) if mine is not None else None,
    )


@router.post("", response_model=ReviewOut, status_code=201)
async def create_review(
    data: ReviewCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """发表 / 更新评测或评分。

    同一用户对同一桌游只保留一条记录。
    - 带正文（content）的是「评测」；只打分不带正文的是「纯评分」。
    - 更新时：正文为空则清空正文（退回纯评分），避免残留旧正文。
    """
    game = await db.get(BoardGame, data.game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    existing = (
        await db.execute(
            select(Review).where(
                Review.user_id == current_user.id, Review.game_id == data.game_id
            )
        )
    ).scalar_one_or_none()

    content = data.content.strip() if data.content and data.content.strip() else None

    if existing:
        existing.rating = data.rating
        existing.content = content
        review = existing
    else:
        review = Review(
            user_id=current_user.id,
            game_id=data.game_id,
            rating=data.rating,
            content=content,
        )
        db.add(review)

    await _recalc(db, data.game_id)
    await db.commit()
    await db.refresh(review)
    return _to_out(review, current_user.username, game.name)


@router.post("/{review_id}/images", response_model=ReviewImageResult)
async def upload_review_images(
    review_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """给自己的评测追加图片，累计最多 9 张。"""
    review = await db.get(Review, review_id)
    if not review:
        raise HTTPException(404, "评测不存在")
    if review.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(403, "只能给自己的评测上传图片")

    already = list(review.images or [])
    room = MAX_IMAGES - len(already)
    if room <= 0:
        raise HTTPException(400, f"最多上传 {MAX_IMAGES} 张图片")
    if len(files) > room:
        raise HTTPException(400, f"还能上传 {room} 张，本次选择了 {len(files)} 张")

    os.makedirs(os.path.join(UPLOAD_ROOT, str(review_id)), exist_ok=True)
    added: list[str] = []
    for f in files:
        ext = ALLOWED_EXT.get(f.content_type or "")
        if not ext:
            raise HTTPException(400, "只支持 jpg / png / webp 图片")
        body = await f.read()
        if len(body) > MAX_BYTES:
            raise HTTPException(400, "单张图片不能超过 5MB")
        # 文件名服务端生成，不信任客户端传入的名字
        name = f"{uuid.uuid4().hex}{ext}"
        with open(os.path.join(UPLOAD_ROOT, str(review_id), name), "wb") as fp:
            fp.write(body)
        added.append(f"/uploads/reviews/{review_id}/{name}")

    review.images = already + added
    await db.commit()
    return ReviewImageResult(review_id=review_id, images=list(review.images))


@router.post("/{review_id}/like", response_model=ReviewLikeResult)
async def toggle_like(
    review_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """点赞 / 取消点赞，同一用户同一评测只记一次。"""
    review = await db.get(Review, review_id)
    if not review:
        raise HTTPException(404, "评测不存在")

    existing = (
        await db.execute(
            select(ReviewLike).where(
                ReviewLike.review_id == review_id, ReviewLike.user_id == current_user.id
            )
        )
    ).scalar_one_or_none()

    if existing:
        await db.delete(existing)
        review.like_count = max(0, int(review.like_count or 0) - 1)
        liked = False
    else:
        db.add(ReviewLike(review_id=review_id, user_id=current_user.id))
        review.like_count = int(review.like_count or 0) + 1
        liked = True

    await db.commit()
    return ReviewLikeResult(review_id=review_id, like_count=int(review.like_count or 0), liked=liked)


@router.get("/{review_id}/comments", response_model=list[ReviewCommentOut])
async def list_comments(review_id: int, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(ReviewComment, User.username.label("username"))
            .join(User, User.id == ReviewComment.user_id)
            .where(ReviewComment.review_id == review_id)
            .order_by(ReviewComment.id.asc())
        )
    ).all()
    return [
        ReviewCommentOut(
            id=c.ReviewComment.id,
            review_id=c.ReviewComment.review_id,
            user_id=c.ReviewComment.user_id,
            content=c.ReviewComment.content,
            created_at=c.ReviewComment.created_at,
            username=c.username,
        )
        for c in rows
    ]


@router.post("/{review_id}/comments", response_model=ReviewCommentOut, status_code=201)
async def create_comment(
    review_id: int,
    data: ReviewCommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    review = await db.get(Review, review_id)
    if not review:
        raise HTTPException(404, "评测不存在")

    comment = ReviewComment(
        review_id=review_id,
        user_id=current_user.id,
        content=data.content.strip(),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return ReviewCommentOut(
        id=comment.id,
        review_id=comment.review_id,
        user_id=comment.user_id,
        content=comment.content,
        created_at=comment.created_at,
        username=current_user.username,
    )


@router.delete("/{review_id}")
async def delete_review(
    review_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除自己的评测，清理图片磁盘文件，并同步重算该桌游均分。"""
    review = await db.get(Review, review_id)
    if not review:
        raise HTTPException(404, "评测不存在")
    if review.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(403, "只能删除自己的评测")

    game_id = review.game_id
    await db.delete(review)
    await _recalc(db, game_id)
    await db.commit()

    # 评测删除后再清图（外键级联会带上 likes / comments；图片目录按 review_id 命名）
    if re.fullmatch(r"\d+", str(review_id)):
        img_dir = os.path.join(UPLOAD_ROOT, str(review_id))
        if os.path.isdir(img_dir):
            for fn in os.listdir(img_dir):
                try:
                    os.remove(os.path.join(img_dir, fn))
                except OSError:
                    pass
            try:
                os.rmdir(img_dir)
            except OSError:
                pass
    return {"detail": "已删除"}
