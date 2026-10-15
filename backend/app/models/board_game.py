from sqlalchemy import Float, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BoardGame(Base):
    __tablename__ = "board_games"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    name_en: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    cover_image: Mapped[str | None] = mapped_column(String(500), nullable=True)
    min_players: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_players: Mapped[int | None] = mapped_column(Integer, nullable=True)
    play_time_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_age: Mapped[int | None] = mapped_column(Integer, nullable=True)
    complexity: Mapped[float | None] = mapped_column(Float, nullable=True)  # 1~5
    categories: Mapped[list] = mapped_column(JSONB, default=list)  # 分类标签名数组
    mechanics: Mapped[list] = mapped_column(JSONB, default=list)  # 机制标签名数组
    publisher: Mapped[str | None] = mapped_column(String(200), nullable=True)
    year_published: Mapped[int | None] = mapped_column(Integer, nullable=True)
    avg_rating: Mapped[float] = mapped_column(Float, default=0.0)
    rating_count: Mapped[int] = mapped_column(Integer, default=0)

    # ── 详情补充字段（数据来源：站内存档的 BGG 原始资料）──
    bgg_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    """BGG 站内 ID，用于回链与去重"""
    description_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    """BGG 官方英文简介原文（未改写）"""
    bgg_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    designers: Mapped[list] = mapped_column(JSONB, default=list)
    artists: Mapped[list] = mapped_column(JSONB, default=list)
    min_playtime: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_playtime: Mapped[int | None] = mapped_column(Integer, nullable=True)
    admin_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    """管理端维护备注，仅后台可见，不对外展示"""
