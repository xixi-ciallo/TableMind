"""P3 四维评测表（用例 / 批次 / 结果）

Revision ID: i4d5e6f7a8b0
Revises: h3c4d5e6f8a9
Create Date: 2026-10-27
"""
from alembic import op
import sqlalchemy as sa

revision = "i4d5e6f7a8b0"
down_revision = "h3c4d5e6f8a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rag_eval_cases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "game_id",
            sa.Integer(),
            sa.ForeignKey("board_games.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("reference_answer", sa.Text(), nullable=True),
        sa.Column("reference_chunks", sa.JSON(), nullable=True),
        sa.Column("tags", sa.String(length=120), nullable=True),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_rag_eval_cases_game_id", "rag_eval_cases", ["game_id"])

    op.create_table(
        "rag_eval_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("case_count", sa.Integer(), nullable=False),
        sa.Column("completed_count", sa.Integer(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=True),
        sa.Column("summary", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
    )

    op.create_table(
        "rag_eval_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Integer(),
            sa.ForeignKey("rag_eval_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "case_id",
            sa.Integer(),
            sa.ForeignKey("rag_eval_cases.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("game_id", sa.Integer(), nullable=True),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("reference_answer", sa.Text(), nullable=True),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("contexts", sa.JSON(), nullable=True),
        sa.Column("citations", sa.JSON(), nullable=True),
        sa.Column("context_recall", sa.Float(), nullable=True),
        sa.Column("context_precision", sa.Float(), nullable=True),
        sa.Column("faithfulness", sa.Float(), nullable=True),
        sa.Column("answer_relevance", sa.Float(), nullable=True),
        sa.Column("overall", sa.Float(), nullable=True),
        sa.Column("judge_reasons", sa.JSON(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_rag_eval_results_run_id", "rag_eval_results", ["run_id"])
    op.create_index("ix_rag_eval_results_case_id", "rag_eval_results", ["case_id"])


def downgrade() -> None:
    op.drop_index("ix_rag_eval_results_case_id", table_name="rag_eval_results")
    op.drop_index("ix_rag_eval_results_run_id", table_name="rag_eval_results")
    op.drop_table("rag_eval_results")
    op.drop_table("rag_eval_runs")
    op.drop_index("ix_rag_eval_cases_game_id", table_name="rag_eval_cases")
    op.drop_table("rag_eval_cases")
