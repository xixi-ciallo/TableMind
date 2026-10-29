"""P4 运行时配置表（当前值 + 变更审计）

Revision ID: j5e6f7a8b9c1
Revises: i4d5e6f7a8b0
Create Date: 2026-10-27
"""
from alembic import op
import sqlalchemy as sa

revision = "j5e6f7a8b9c1"
down_revision = "i4d5e6f7a8b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_configs",
        sa.Column("key", sa.String(length=64), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("updated_by_id", sa.Integer(), nullable=True),
        sa.Column("updated_by_name", sa.String(length=50), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
    )

    op.create_table(
        "app_config_audits",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(length=64), nullable=False),
        # set / reset / rollback
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("operator_id", sa.Integer(), nullable=True),
        sa.Column("operator_name", sa.String(length=50), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_app_config_audits_key", "app_config_audits", ["key"])


def downgrade() -> None:
    op.drop_index("ix_app_config_audits_key", table_name="app_config_audits")
    op.drop_table("app_config_audits")
    op.drop_table("app_configs")
