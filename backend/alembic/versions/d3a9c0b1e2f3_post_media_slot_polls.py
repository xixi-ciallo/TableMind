"""post_media.slot（头图/内嵌区分）+ 帖子投票三表

Revision ID: d3a9c0b1e2f3
Revises: b2c7d8e9f0a1
Create Date: 2026-10-10
"""

from alembic import op
import sqlalchemy as sa

revision = "d3a9c0b1e2f3"
down_revision = "b2c7d8e9f0a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "post_media",
        sa.Column("slot", sa.String(10), nullable=False, server_default="inline"),
    )
    op.create_table(
        "post_polls",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "post_id",
            sa.Integer(),
            sa.ForeignKey("posts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("question", sa.String(100), nullable=False),
        sa.Column("multi", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("end_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
    )
    op.create_index("ix_post_polls_post_id", "post_polls", ["post_id"])
    op.create_table(
        "post_poll_options",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "poll_id",
            sa.Integer(),
            sa.ForeignKey("post_polls.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.String(50), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_post_poll_options_poll_id", "post_poll_options", ["poll_id"])
    op.create_table(
        "post_poll_votes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "poll_id",
            sa.Integer(),
            sa.ForeignKey("post_polls.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "option_id",
            sa.Integer(),
            sa.ForeignKey("post_poll_options.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=True, server_default=sa.func.now()),
        sa.UniqueConstraint("poll_id", "user_id", "option_id", name="uq_poll_vote"),
    )
    op.create_index("ix_post_poll_votes_poll_id", "post_poll_votes", ["poll_id"])


def downgrade() -> None:
    op.drop_index("ix_post_poll_votes_poll_id", table_name="post_poll_votes")
    op.drop_table("post_poll_votes")
    op.drop_index("ix_post_poll_options_poll_id", table_name="post_poll_options")
    op.drop_table("post_poll_options")
    op.drop_index("ix_post_polls_post_id", table_name="post_polls")
    op.drop_table("post_polls")
    op.drop_column("post_media", "slot")
