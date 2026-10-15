"""
种子脚本：创建初始管理员账号。

生产环境请务必修改 ADMIN_PASSWORD，并避免使用默认密码！
运行方式：
    python seed_admin.py
"""

import asyncio
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import hash_password
from app.models.user import User

# 从环境变量读取管理员账号密码，默认 admin / admin123
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
ADMIN_PHONE = os.getenv("ADMIN_PHONE", "13000000000")

engine = create_async_engine(settings.DATABASE_URL, echo=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def create_admin():
    async with SessionLocal() as session:
        result = await session.execute(select(User).where(User.username == ADMIN_USERNAME))
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                username=ADMIN_USERNAME,
                phone=ADMIN_PHONE,
                password_hash=hash_password(ADMIN_PASSWORD),
                role="admin",
                is_active=True,
            )
            session.add(user)
            await session.commit()
            print(f"管理员账号 '{ADMIN_USERNAME}' 已创建。")
        else:
            print(f"管理员账号 '{ADMIN_USERNAME}' 已存在，跳过创建。")


if __name__ == "__main__":
    asyncio.run(create_admin())
