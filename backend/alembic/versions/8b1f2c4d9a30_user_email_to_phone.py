"""user email -> phone

用户注册凭证由邮箱改为手机号：users.email 唯一索引列替换为 users.phone（唯一 + 索引）。

对历史数据的处理：现存账号无法凭空获得真实手机号，这里按 id 生成一个
合法的占位号码（形如 13xxxxxxxxx），仅用于满足 NOT NULL 与唯一约束。
上线前须通知这些账号通过管理端补填真实手机号。

Revision ID: 8b1f2c4d9a30
Revises: 26d3a425a10b
Create Date: 2026-10-05 22:35:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '8b1f2c4d9a30'
down_revision = '26d3a425a10b'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) 先以可空列加入 phone，避免已有数据阻塞
    op.add_column('users', sa.Column('phone', sa.String(length=20), nullable=True))
    # 2) 为历史账号回填唯一占位号码（13 开头，11 位，符合手机号格式）
    op.execute(
        "UPDATE users SET phone = '1' || lpad((3000000000 + id)::text, 10, '0') "
        "WHERE phone IS NULL"
    )
    # 3) 收紧为 NOT NULL 并建立唯一索引
    op.alter_column('users', 'phone', existing_type=sa.String(length=20), nullable=False)
    op.create_index(op.f('ix_users_phone'), 'users', ['phone'], unique=True)
    # 4) 移除旧的 email 列与索引
    op.drop_index(op.f('ix_users_email'), table_name='users')
    op.drop_column('users', 'email')


def downgrade() -> None:
    op.add_column('users', sa.Column('email', sa.String(length=255), nullable=True))
    op.execute("UPDATE users SET email = phone || '@placeholder.local' WHERE email IS NULL")
    op.alter_column('users', 'email', existing_type=sa.String(length=255), nullable=False)
    op.create_index(op.f('ix_users_email'), 'users', ['email'], unique=True)
    op.drop_index(op.f('ix_users_phone'), table_name='users')
    op.drop_column('users', 'phone')
