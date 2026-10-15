from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PostMedia(Base):
    """帖子附件：图片 / 视频。

    发布流程：先在发布页上传（此时 post_id 为空，属草稿态），发布帖子时再把
    这批 media 绑定到帖子。落盘路径 backend/uploads/posts/<user_id>/<uuid>.<ext>，
    由 FastAPI 静态挂载 /uploads 提供访问。
    slot=header 头图区（最多 18 张图或 1 个视频，互斥，第一张图为封面）；
    slot=inline 正文内嵌媒体。
    """

    __tablename__ = "post_media"

    id: Mapped[int] = mapped_column(primary_key=True)
    post_id: Mapped[int | None] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    """image=图片，video=视频"""
    kind: Mapped[str] = mapped_column(String(10))
    """header=头图区，inline=正文内嵌"""
    slot: Mapped[str] = mapped_column(String(10), default="inline", server_default="inline")
    url: Mapped[str] = mapped_column(String(500))
    sort_order: Mapped[int] = mapped_column(default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
