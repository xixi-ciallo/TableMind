from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# 连接池容量：默认 pool_size=5 + max_overflow=10（共 15）扛不住 50 并发——
# 实测 50 并发压测会抛 TimeoutError「QueuePool limit of size 5 overflow 10 reached」
# 并导致 500。一条 AI 问答会串联多次 DB 查询（会话/画像/规则切片/历史写回），
# 单请求占用连接的时间远长于普通 CRUD，故按并发目标放大连接池。
# pool_pre_ping 防止拿到被数据库断开的陈旧连接。
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=20,
    max_overflow=30,
    pool_timeout=60,
    pool_recycle=1800,
    pool_pre_ping=True,
)

async_session_factory = async_sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


class Base(DeclarativeBase):
    pass


async def get_db():
    """FastAPI 依赖：提供 AsyncSession，请求结束后自动关闭"""
    async with async_session_factory() as session:
        yield session
