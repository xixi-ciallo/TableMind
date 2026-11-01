# -*- coding: utf-8 -*-
"""环境自检：新人上手 / 换机重建后，先跑这个定位环境问题。

用法（在 backend 目录）：
    python check_env.py

检查项（全部只读，不改任何数据）：
    1. 根目录 .env 存在且关键变量已填（SECRET_KEY 非占位、DATABASE_URL、REDIS_URL）
    2. PostgreSQL 可连接、pgvector 扩展已启用、表结构已建（users 表存在）
    3. Redis 可连接（RESP2 协议，兼容 Redis 5.x）
    4. LLM Key 已配置（可选，未配只影响 AI 功能）
    5. 后端进程存活探测（http://127.0.0.1:8000/api/health，未启动只是提示不算失败）
"""
import asyncio
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> dict:
    """极简 .env 解析（KEY=VALUE，忽略注释/空行），仅供自检，不替代 pydantic-settings。"""
    env = {}
    path = ROOT / ".env"
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip("'\"")
    return env


def mark(ok: bool, label: str, hint: str = "") -> bool:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" —— {hint}" if not ok and hint else ""))
    return ok


def warn(label: str, hint: str = "") -> None:
    print(f"  [WARN] {label}" + (f" —— {hint}" if hint else ""))


def check_env_vars(env: dict) -> bool:
    print("\n[1/5] 环境变量（根目录 .env）")
    if not mark(bool(env), ".env 文件存在", f"未找到 {ROOT / '.env'}，请复制 .env.example 为 .env 并填写"):
        return False
    ok = True
    ok &= mark(bool(env.get("DATABASE_URL")), "DATABASE_URL 已配置")
    ok &= mark(bool(env.get("REDIS_URL")), "REDIS_URL 已配置")
    secret = env.get("SECRET_KEY", "")
    if not mark(bool(secret) and secret != "change-me", "SECRET_KEY 已配置且非占位符",
                "必须设为强随机值，占位符会导致鉴权失效"):
        ok = False
    if not env.get("LLM_API_KEY"):
        warn("LLM_API_KEY 未配置", "游戏库/社区/榜单可用，AI 问答与推荐不可用")
    return ok


async def check_postgres(env: dict) -> bool:
    print("\n[2/5] PostgreSQL + pgvector + 表结构")
    url = env.get("DATABASE_URL", "")
    if not url:
        print("  [SKIP] 未配置 DATABASE_URL")
        return False
    dsn = url.replace("postgresql+asyncpg://", "postgresql://")
    try:
        import asyncpg
    except ImportError:
        print("  [FAIL] asyncpg 未安装，先执行 pip install -r requirements.txt")
        return False
    try:
        conn = await asyncio.wait_for(asyncpg.connect(dsn, timeout=5), timeout=8)
    except Exception as exc:  # noqa: BLE001
        mark(False, "PostgreSQL 可连接", f"{exc}；请确认已运行 .\\local-env\\start-env.bat 或 docker-compose up -d")
        return False
    try:
        ver = await conn.fetchval("SELECT version()")
        print(f"  [PASS] 可连接（{ver.split(',')[0]}）")
        ext = await conn.fetchval("SELECT count(*) FROM pg_extension WHERE extname='vector'")
        mark(ext > 0, "pgvector 扩展已启用",
             "执行 CREATE EXTENSION vector（迁移本会自动建，报 type vector does not exist 时手动建）")
        tables = await conn.fetchval(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='users'")
        if tables > 0:
            games = await conn.fetchval("SELECT count(*) FROM board_games")
            print(f"  [PASS] 表结构已建（board_games {games} 条）")
            if games == 0:
                warn("桌游库为空", "执行 python seed_all.py 初始化数据")
        else:
            mark(False, "表结构已建", "库为空，执行 alembic upgrade head 建表")
        return True
    finally:
        await conn.close()


def check_redis(env: dict) -> bool:
    print("\n[3/5] Redis")
    url = env.get("REDIS_URL", "redis://localhost:6379/0")
    # 不依赖 redis 库：直接 RESP2 握手，兼容任何版本
    try:
        host, _, port = url.split("//")[1].partition(":")
        port = int(port.split("/")[0]) if port else 6379
        with socket.create_connection((host, port), timeout=3) as s:
            s.sendall(b"PING\r\n")
            resp = s.recv(16)
        if resp.startswith(b"+PONG"):
            print("  [PASS] 可连接且响应 PING")
            return True
        mark(False, "PING 响应异常", f"收到 {resp!r}")
        return False
    except Exception as exc:  # noqa: BLE001
        mark(False, "可连接", f"{exc}；Redis 未启动时后端会在启动后约 10 秒静默崩溃，务必先启动")
        return False


def check_llm(env: dict) -> None:
    print("\n[4/5] LLM 配置（可选）")
    if not env.get("LLM_API_KEY"):
        warn("LLM_API_KEY 未配置", "填入百炼 DashScope Key 后 AI 问答/推荐才可用")
        return
    base = env.get("LLM_BASE_URL", "（默认 DashScope）")
    print(f"  [PASS] LLM_API_KEY 已配置（BASE_URL={base}，模型={env.get('LLM_MODEL', '默认 deepseek-flash')}）")


def check_backend() -> None:
    print("\n[5/5] 后端进程探测（可选）")
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=3) as r:
            if r.status == 200:
                print("  [PASS] 后端已启动（http://127.0.0.1:8000/api/health）")
                return
    except Exception:  # noqa: BLE001
        pass
    warn("后端未启动", "在项目根目录执行 python backend\\run.py（Windows 必须从根目录启动）")


async def main() -> int:
    print("TableMind 环境自检（只读，不修改任何数据）")
    env = load_env()
    r1 = check_env_vars(env)
    r2 = await check_postgres(env)
    r3 = check_redis(env)
    check_llm(env)
    check_backend()
    hard = r1 and r2 and r3
    print("\n===== 结论 =====")
    print("核心依赖（.env / PostgreSQL / Redis）全部就绪，可以启动后端。" if hard
          else "存在未通过的必选项，请按上方 FAIL 项的提示处理后重跑。")
    return 0 if hard else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
