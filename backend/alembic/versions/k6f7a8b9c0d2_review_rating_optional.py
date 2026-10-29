"""评测与评分分离：reviews.rating 允许为空

「玩家评分」入口只写 rating，「玩家评测」入口只写 content，
因此同一条记录可能只有正文没有分数。

Revision ID: k6f7a8b9c0d2
Revises: j5e6f7a8b9c1
Create Date: 2026-10-29
"""
from alembic import op
import sqlalchemy as sa

revision = "k6f7a8b9c0d2"
down_revision = "j5e6f7a8b9c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("reviews", "rating", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    # 回滚前先把无评分的记录补成中位分，避免 NOT NULL 失败
    op.execute("UPDATE reviews SET rating = 5 WHERE rating IS NULL")
    op.alter_column("reviews", "rating", existing_type=sa.Integer(), nullable=False)
