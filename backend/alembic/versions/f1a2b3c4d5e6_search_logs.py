"""search_logs 表

Revision ID: f1a2b3c4d5e6
Revises: e7c3d94a5b21
Create Date: 2026-10-09
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "f1a2b3c4d5e6"
down_revision = "e7c3d94a5b21"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "search_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("term", sa.String(length=120), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_search_logs_user_id", "search_logs", ["user_id"])
    op.create_index("ix_search_logs_kind", "search_logs", ["kind"])
    op.create_index("ix_search_logs_term", "search_logs", ["term"])


def downgrade() -> None:
    op.drop_index("ix_search_logs_term", table_name="search_logs")
    op.drop_index("ix_search_logs_kind", table_name="search_logs")
    op.drop_index("ix_search_logs_user_id", table_name="search_logs")
    op.drop_table("search_logs")
