"""posts 增加浏览量 view_count

Revision ID: e7c3d94a5b21
Revises: d4f2a71c9b10
Create Date: 2026-10-09
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "e7c3d94a5b21"
down_revision = "d4f2a71c9b10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "posts",
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("posts", "view_count")
