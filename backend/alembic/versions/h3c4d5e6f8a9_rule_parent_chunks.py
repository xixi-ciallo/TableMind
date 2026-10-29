"""规则文档父子分块（parent_index / parent_text）

Revision ID: h3c4d5e6f8a9
Revises: g2b3c4d5e6f7
Create Date: 2026-10-27
"""
from alembic import op
import sqlalchemy as sa

revision = "h3c4d5e6f8a9"
down_revision = "g2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rule_documents", sa.Column("parent_index", sa.Integer(), nullable=True)
    )
    op.add_column("rule_documents", sa.Column("parent_text", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("rule_documents", "parent_text")
    op.drop_column("rule_documents", "parent_index")
