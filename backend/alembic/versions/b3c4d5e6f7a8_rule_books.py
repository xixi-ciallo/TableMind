"""规则书（rule_books）与规则文档（rule_documents）分表。

新增 rule_books 存原始说明书文件（PDF / 逐页图片），rule_documents 加 rule_book_id 外键，
使「可翻阅的规则书」与「供检索的规则文档切片」在数据层彻底分离。
已有 416 条历史切片 rule_book_id 保持 NULL（来源为站内扫描页 OCR，当时无规则书记录）。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b3c4d5e6f7a8"
down_revision: Union[str, None] = "a0b1c2d3e4f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "rule_books",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("game_id", sa.Integer(), sa.ForeignKey("board_games.id", ondelete="CASCADE"), index=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("file_type", sa.String(16), nullable=False),
        sa.Column("file_path", sa.String(500), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("language", sa.String(16), nullable=False, server_default="zh"),
        sa.Column("is_official", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("source", sa.String(200), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_rule_books_created_at", "rule_books", ["created_at"])
    op.add_column(
        "rule_documents",
        sa.Column(
            "rule_book_id",
            sa.Integer(),
            sa.ForeignKey("rule_books.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index("ix_rule_documents_rule_book_id", "rule_documents", ["rule_book_id"])


def downgrade() -> None:
    op.drop_index("ix_rule_documents_rule_book_id", table_name="rule_documents")
    op.drop_column("rule_documents", "rule_book_id")
    op.drop_index("ix_rule_books_created_at", table_name="rule_books")
    op.drop_table("rule_books")
