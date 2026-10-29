import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.agent import dialogue_state
from app.api.admin import router as admin_router
from app.api.user import router as user_router
from app.core.database import async_session_factory
from app.core.runtime_config import refresh_runtime_config

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 对话状态存储（LangGraph AsyncPostgresStore）：初始化失败会内部降级，不阻断启动
    await dialogue_state.init_store()
    # P4 运行时配置：把数据库覆盖值应用到 settings（表未建好/连接失败时继续用 .env）
    try:
        async with async_session_factory() as db:
            applied = await refresh_runtime_config(db)
        if applied:
            log.info("运行时配置已加载 %s 项数据库覆盖值", len(applied))
    except Exception as exc:  # noqa: BLE001
        log.warning("运行时配置加载失败，继续使用 .env 值：%s", exc)
    yield
    await dialogue_state.close_store()


app = FastAPI(title="TableMind API", version="0.1.0", lifespan=lifespan)

# 评测图片等上传资源的静态挂载目录
UPLOADS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

# CORS：允许前端开发服务器（Vite 默认端口 5173）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 用户端路由（/api 前缀）
app.include_router(user_router, prefix="/api")

# 管理端路由（/api/admin 前缀），内部已统一依赖 require_admin
app.include_router(admin_router, prefix="/api/admin")


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}
