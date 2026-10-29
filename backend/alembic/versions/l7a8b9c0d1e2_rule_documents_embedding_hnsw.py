"""rule_documents.embedding 增加 HNSW 余弦索引

向量检索下沉到 pgvector：`ORDER BY embedding <=> :q LIMIT n` 走该索引，
不再把整列向量拉回 Python 逐条计算余弦。

Revision ID: l7a8b9c0d1e2
Revises: k6f7a8b9c0d2
Create Date: 2026-10-29
"""
from alembic import op

revision = "l7a8b9c0d1e2"
down_revision = "k6f7a8b9c0d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_rule_documents_embedding_hnsw",
        "rule_documents",
        ["embedding"],
        unique=False,
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_rule_documents_embedding_hnsw", table_name="rule_documents")
