"""post_marks（帖子收藏）+ comment_likes（评论赞/踩）

Revision ID: c9e5f6a7b8d1
Revises: f1a2b3c4d5e6
Create Date: 2026-10-10
"""

from alembic import op
import sqlalchemy as sa

revision = "c9e5f6a7b8d1"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "post_marks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "post_id",
            sa.Integer(),
            sa.ForeignKey("posts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("post_id", "user_id", name="uq_post_mark_user"),
    )
    op.create_table(
        "comment_likes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "comment_id",
            sa.Integer(),
            sa.ForeignKey("comments.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("value", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("comment_id", "user_id", name="uq_comment_like_user"),
    )


def downgrade() -> None:
    op.drop_table("comment_likes")
    op.drop_table("post_marks")
