"""开发环境启动入口（Windows 友好）。

用法（必须在项目根目录执行，保证根目录 .env 被加载）：

    python backend\\run.py

解决两个已知问题：
1. psycopg 的异步模式不支持 Windows 默认的 ProactorEventLoop，
   LangGraph AsyncPostgresStore 会因此初始化失败。
   注意：uvicorn 0.54 在 Windows 上会无视全局 policy 直接创建 ProactorEventLoop，
   因此这里不走 uvicorn.run()，而是用 asyncio.Runner 显式指定 SelectorEventLoop。
2. Settings 的 env_file=".env" 相对于当前工作目录，
   在 backend/ 下启动会读不到根目录 .env（表现为 /api/ai/status 返回 llm_enabled=false）。
"""
import asyncio
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import uvicorn  # noqa: E402


def main() -> None:
    if not os.path.exists(os.path.join(os.getcwd(), ".env")):
        print(
            "[warn] 当前工作目录没有 .env，配置将使用默认值。"
            "请在项目根目录执行：python backend\\run.py",
            file=sys.stderr,
        )

    config = uvicorn.Config(
        "app.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        log_level=os.getenv("LOG_LEVEL", "info"),
        # loop 交由下面的 Runner 决定，避免 uvicorn 在 Windows 上强上 ProactorEventLoop
        loop="none",
    )
    server = uvicorn.Server(config)
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    with asyncio.Runner(loop_factory=loop_factory) as runner:
        runner.run(server.serve())


if __name__ == "__main__":
    main()
