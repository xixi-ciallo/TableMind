"""agent_runs / agent_steps：Agentic RAG 节点级执行轨迹

参考架构要求「每个节点都落一条 agent_step」：一次问答一条 agent_run 主记录，
每个图节点一条 agent_step 明细（节点名/入参摘要/出参摘要/状态/耗时），
用于 badcase 逐节点回放。

Revision ID: m8b9c0d1e2f3
Revises: l7a8b9c0d1e2
Create Date: 2026-11-01
"""
import sqlalchemy as sa
from alembic import op

revision = "m8b9c0d1e2f3"
down_revision = "l7a8b9c0d1e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("level", sa.SmallInteger(), nullable=True),
        sa.Column("fallback", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("check_passed", sa.Boolean(), nullable=True),
        sa.Column("external", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("chars", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="ok"),
        sa.Column("error", sa.String(200), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("node_count", sa.SmallInteger(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_agent_runs_created_at", "agent_runs", ["created_at"])
    op.create_table(
        "agent_steps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Integer(),
            sa.ForeignKey("agent_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.SmallInteger(), nullable=False),
        sa.Column("node", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ok"),
        sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input", sa.JSON(), nullable=True),
        sa.Column("output", sa.JSON(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_agent_steps_run_id", "agent_steps", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_steps_run_id", table_name="agent_steps")
    op.drop_table("agent_steps")
    op.drop_index("ix_agent_runs_created_at", table_name="agent_runs")
    op.drop_table("agent_runs")
