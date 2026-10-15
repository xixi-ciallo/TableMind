"""post_media（帖子图片 / 视频附件）

Revision ID: b2c7d8e9f0a1
Revises: c9e5f6a7b8d1
Create Date: 2026-10-10
"""

from alembic import op
import sqlalchemy as sa

revision = "b2c7d8e9f0a1"
down_revision = "c9e5f6a7b8d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "post_media",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "post_id",
            sa.Integer(),
            sa.ForeignKey("posts.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("url", sa.String(500), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
    )
    op.create_index("ix_post_media_post_id", "post_media", ["post_id"])
    op.create_index("ix_post_media_user_id", "post_media", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_post_media_user_id", table_name="post_media")
    op.drop_index("ix_post_media_post_id", table_name="post_media")
    op.drop_table("post_media")
