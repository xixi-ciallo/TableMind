from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, Index, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RuleDocument(Base):
    """规则文档切片（RAG 数据源），embedding 供 pgvector 相似度检索。

    来源是 `rule_books` 里的规则书；`rule_book_id` 为空表示历史数据（OCR 站内扫描页时期入库，
    当时还没有独立的规则书记录）。

    **父子分块**：`content` 是子片（用于向量匹配，定位精确）；`parent_text` 是它所属的
    完整语义章节（用于回填给模型，保留上下文）。同一章节被切成多片时，这些行的
    `parent_index` 相同（指向该章节首片的 chunk_index）。历史数据没有父片信息，
    检索时自动回落到 `content`。
    """

    __tablename__ = "rule_documents"
    __table_args__ = (
        # HNSW 索引：检索按余弦距离（<=>）取 Top-N 时直接走索引，不做全表向量扫描。
        # m/ef_construction 用 pgvector 默认值，语料规模增大后再按召回率调。
        Index(
            "ix_rule_documents_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("board_games.id"), index=True)
    rule_book_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_books.id", ondelete="CASCADE"), index=True, nullable=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    parent_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parent_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(1536), nullable=True
    )
