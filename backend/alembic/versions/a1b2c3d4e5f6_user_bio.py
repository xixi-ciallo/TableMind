"""users 加 bio 个人简介列（个人中心展示与编辑）

Revision ID: a1b2c3d4e5f6
Revises: d3a9c0b1e2f3
Create Date: 2026-10-11
"""

from alembic import op
import sqlalchemy as sa

revision = "a1b2c3d4e5f6"
down_revision = "d3a9c0b1e2f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("bio", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "bio")
