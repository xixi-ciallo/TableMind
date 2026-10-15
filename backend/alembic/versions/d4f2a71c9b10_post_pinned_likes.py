"""社区升级：帖子置顶 + 帖子点赞

- posts.is_pinned：官方公告置顶标记
- post_likes：记录真实点赞关系，避免重复点赞
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4f2a71c9b10"
down_revision: Union[str, None] = "c7e1b93a4f21"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "posts",
        sa.Column("is_pinned", sa.Boolean(), server_default=sa.false(), nullable=False),
    )

    op.create_table(
        "post_likes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("post_id", sa.Integer(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("post_id", "user_id", name="uq_post_like_user"),
    )


def downgrade() -> None:
    op.drop_table("post_likes")
    op.drop_column("posts", "is_pinned")
