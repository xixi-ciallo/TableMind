"""board_games 补充桌游详情字段

来源：站内已存档的 BGG 原始数据（.workbuddy/tmp/geekdo_raw.json / geekdo_more.json），
新增字段用于承载真实存在的出版信息，无可信来源的字段（如 BGG 权重复杂度）不入库。

Revision ID: 5c8e1f07ab34
Revises: a1b2c3d4e5f6
Create Date: 2026-10-12
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "5c8e1f07ab34"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("board_games", sa.Column("bgg_id", sa.Integer(), nullable=True))
    op.add_column("board_games", sa.Column("description_en", sa.Text(), nullable=True))
    op.add_column("board_games", sa.Column("bgg_url", sa.String(500), nullable=True))
    op.add_column(
        "board_games",
        sa.Column("designers", postgresql.JSONB(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "board_games",
        sa.Column("artists", postgresql.JSONB(), nullable=False, server_default="[]"),
    )
    op.add_column("board_games", sa.Column("min_playtime", sa.Integer(), nullable=True))
    op.add_column("board_games", sa.Column("max_playtime", sa.Integer(), nullable=True))
    op.add_column("board_games", sa.Column("admin_note", sa.Text(), nullable=True))
    """管理端维护备注，仅后台可见（此前前端已有该输入框但库里没有对应列）"""
    op.create_index("ix_board_games_bgg_id", "board_games", ["bgg_id"])


def downgrade() -> None:
    op.drop_index("ix_board_games_bgg_id", table_name="board_games")
    op.drop_column("board_games", "admin_note")
    op.drop_column("board_games", "max_playtime")
    op.drop_column("board_games", "min_playtime")
    op.drop_column("board_games", "artists")
    op.drop_column("board_games", "designers")
    op.drop_column("board_games", "bgg_url")
    op.drop_column("board_games", "description_en")
    op.drop_column("board_games", "bgg_id")
