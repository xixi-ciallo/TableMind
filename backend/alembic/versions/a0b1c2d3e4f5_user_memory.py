"""用户记忆层（个性化）：user_profiles + user_memory_episodes

与 RAG 语义记忆（rule_documents，存「事实/规则」）分开的两张表：
- user_profiles：每用户一行的结构化偏好快照（情景/语义混合记忆）。
- user_memory_episodes：按时间追加的具体交互事件（情景记忆）。

Revision ID: a0b1c2d3e4f5
Revises: 5c8e1f07ab34
Create Date: 2026-10-14
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "a0b1c2d3e4f5"
down_revision = "5c8e1f07ab34"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.Integer(), primary_key=True),
        sa.Column("preferred_categories", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("preferred_mechanics", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("disliked_games", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("max_complexity", sa.Float(), nullable=True),
        sa.Column("preferred_player_count", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )

    op.create_table(
        "user_memory_episodes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="feedback"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("game_name", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
    )
    op.create_index("ix_user_memory_episodes_user_id", "user_memory_episodes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_user_memory_episodes_user_id", table_name="user_memory_episodes")
    op.drop_table("user_memory_episodes")
    op.drop_table("user_profiles")
