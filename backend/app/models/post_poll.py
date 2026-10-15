from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PostPoll(Base):
    """帖子投票（一条帖子最多一个投票块，随发帖创建）。"""

    __tablename__ = "post_polls"

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE"), unique=True, index=True
    )
    question: Mapped[str] = mapped_column(String(100))
    """多选投票为 True"""
    multi: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    end_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PostPollOption(Base):
    """投票选项。"""

    __tablename__ = "post_poll_options"

    id: Mapped[int] = mapped_column(primary_key=True)
    poll_id: Mapped[int] = mapped_column(
        ForeignKey("post_polls.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(String(50))
    sort_order: Mapped[int] = mapped_column(default=0, server_default="0")


class PostPollVote(Base):
    """投票记录：单选一人一票；多选一人多票（每选项一条）。"""

    __tablename__ = "post_poll_votes"
    __table_args__ = (UniqueConstraint("poll_id", "user_id", "option_id", name="uq_poll_vote"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    poll_id: Mapped[int] = mapped_column(
        ForeignKey("post_polls.id", ondelete="CASCADE"), index=True
    )
    option_id: Mapped[int] = mapped_column(
        ForeignKey("post_poll_options.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
