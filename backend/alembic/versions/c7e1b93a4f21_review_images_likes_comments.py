"""评测升级：图片 + 点赞 + 回复

- reviews.images：JSON 字符串数组，存评测附带图片的访问路径
- review_likes：记录真实点赞关系，避免重复点赞
- review_comments：评测回复
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c7e1b93a4f21"
down_revision: Union[str, None] = "8b1f2c4d9a30"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("reviews", sa.Column("images", sa.JSON(), nullable=True))

    op.create_table(
        "review_likes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("review_id", sa.Integer(), sa.ForeignKey("reviews.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("review_id", "user_id", name="uq_review_like_user"),
    )

    op.create_table(
        "review_comments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("review_id", sa.Integer(), sa.ForeignKey("reviews.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("review_comments")
    op.drop_table("review_likes")
    op.drop_column("reviews", "images")
