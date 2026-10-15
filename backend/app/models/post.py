from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    game_id: Mapped[int | None] = mapped_column(
        ForeignKey("board_games.id"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    """官方公告置顶：置顶帖排在社区最前"""
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    """浏览量：详情页每次访问 +1，真实计数"""
    view_count: Mapped[int] = mapped_column(default=0, server_default="0")

    user: Mapped["User"] = relationship(lazy="joined")


class PostLike(Base):
    """帖子点赞：记录真实点赞关系，同一用户对同一帖只能点赞一次。"""

    __tablename__ = "post_likes"
    __table_args__ = (UniqueConstraint("post_id", "user_id", name="uq_post_like_user"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PostMark(Base):
    """帖子收藏：记录真实收藏关系，同一用户对同一帖只能收藏一次。"""

    __tablename__ = "post_marks"
    __table_args__ = (UniqueConstraint("post_id", "user_id", name="uq_post_mark_user"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# 供 relationship 解析（避免仅字符串注解导致的配置错误）
from app.models.user import User  # noqa: E402
