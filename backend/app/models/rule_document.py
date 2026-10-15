from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RuleDocument(Base):
    """规则文档切片（RAG 数据源），embedding 供 pgvector 相似度检索。

    来源是 `rule_books` 里的规则书；`rule_book_id` 为空表示历史数据（OCR 站内扫描页时期入库，
    当时还没有独立的规则书记录）。
    """

    __tablename__ = "rule_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("board_games.id"), index=True)
    rule_book_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_books.id", ondelete="CASCADE"), index=True, nullable=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(1536), nullable=True
    )
