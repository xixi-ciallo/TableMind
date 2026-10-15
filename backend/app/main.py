import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.admin import router as admin_router
from app.api.user import router as user_router

app = FastAPI(title="TableMind API", version="0.1.0")

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
