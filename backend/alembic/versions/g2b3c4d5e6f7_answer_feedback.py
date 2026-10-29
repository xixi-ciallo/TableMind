"""答案引用溯源与答案反馈

Revision ID: g2b3c4d5e6f7
Revises: b3c4d5e6f7a8
Create Date: 2026-10-27
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "g2b3c4d5e6f7"
down_revision = "b3c4d5e6f7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("citations", sa.JSON(), nullable=True),
    )
    op.create_table(
        "answer_feedback",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("rating", sa.SmallInteger(), nullable=False),
        sa.Column("reason", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["message_id"], ["chat_messages.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "message_id", "user_id", name="uq_answer_feedback_message_user"
        ),
    )
    op.create_index(
        "ix_answer_feedback_message_id", "answer_feedback", ["message_id"]
    )
    op.create_index("ix_answer_feedback_user_id", "answer_feedback", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_answer_feedback_user_id", table_name="answer_feedback")
    op.drop_index("ix_answer_feedback_message_id", table_name="answer_feedback")
    op.drop_table("answer_feedback")
    op.drop_column("chat_messages", "citations")
