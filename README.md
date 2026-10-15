# TableMind · 桌游信息与 AI 智能问答平台

> 独立全栈项目：桌游信息库 + 玩家社区 + AI 智能助手（定位类似国内版 BoardGameGeek）。

TableMind 是一个一体化 Web 平台，覆盖**用户端**与**管理员端**双应用：提供桌游库检索、评分评测、社区交流，并基于 RAG（检索增强生成）与 Agent 实现规则书智能问答、对话式个性化推荐。

---

## ✨ 功能特性

- **桌游信息库**：47 款桌游的结构化数据（类型、机制、人数、时长、难度等），支持多维筛选与检索；封面等静态资源随库提供。
- **评分评测与社区**：用户收藏（想玩 / 玩过 / 拥有）、评分评测、社区发帖与评论。
- **规则书 RAG 智能问答**：说明书中文化清洗 → 切分 → 向量化入库（1300+ 切片全量向量化）；答案附带规则书引用来源，模型降级时仍返回规则原文、**永不空答**。
- **Agent 对话式推荐**：三级路由（关键词优先 → 追问沿用历史 → LLM 兜底）+ 规则问答 / 个性化推荐双流水线；分层记忆（短期会话 + 长期用户画像）支撑多轮上下文；人数区间、时长上下限等槽位化筛选与流式输出。
- **管理端**：桌游维护、标签管理、用户管理、内容审核，以及基于 ECharts 的数据看板（核心指标卡片 + 近 30 天趋势）。

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python · FastAPI · SQLAlchemy 2.0（全异步 asyncpg）· Alembic |
| 数据库 / 缓存 | PostgreSQL + **pgvector** 向量扩展 · Redis |
| 鉴权 | JWT 无状态（用户名 / 手机号双通道登录，USER / ADMIN 角色隔离） |
| AI / 大模型 | 百炼 DashScope（OpenAI 兼容端点）· `text-embedding-v1`（1536 维）· LangChain · RAG · Agent |
| 检索 | 向量 + **BM25 中文二元组**混合检索，归一化加权融合（VECTOR_WEIGHT=1.0 / BM25_WEIGHT=1.6 / SECTION_BOOST=2.5），hit@5 ≈ 96.0% |
| 前端 | React 18 · TypeScript · Ant Design · Vite · ECharts |

---

## 📁 目录结构

```
TableMind/
├── backend/                 # FastAPI 后端
│   └── app/
│       ├── api/             # 路由（user / admin）
│       ├── agent/           # AI 管线（rag / router / loop / recommend / memory / llm / pool ...）
│       ├── core/            # 配置 / 安全 / 数据库 / 依赖
│       └── models/          # ORM 模型
├── frontend/                # React + Vite 前端
│   ├── src/
│   └── public/              # 静态资源（游戏封面等）
├── docs/                    # 设计 / 评审文档
├── shared/                  # 前后端共享数据（如 gameLibrary.ts）
├── .env.example             # 环境变量模板（复制为 .env 后填写）
└── docker-compose.yml       # 一键起 PG + Redis（可选）
```

---

## 🚀 快速开始

### 1. 准备依赖服务

推荐用 Docker Compose 一键启动 PostgreSQL（含 pgvector）与 Redis：

```bash
docker-compose up -d
```

> 也可使用本地/便携式 PostgreSQL + Redis，只需保证 `DATABASE_URL` 与 `REDIS_URL` 可达，并已启用 `pgvector` 扩展。

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入 SECRET_KEY、LLM_API_KEY、数据库连接等
```

### 3. 后端

```bash
cd backend
pip install -r requirements.txt        # 或所用依赖管理
alembic upgrade head                   # 应用数据库迁移
PYTHONPATH=. uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 4. 前端

```bash
cd frontend
npm install
npm run dev                            # 开发服务器默认 http://localhost:5173
```

前端通过 `/api` 代理到后端 `:8000`。

---

## 🔑 环境变量

复制 `.env.example` 为 `.env` 并填写。关键项：

| 变量 | 说明 |
|------|------|
| `SECRET_KEY` | JWT 签名密钥，**必须设为强随机值**（占位符会导致鉴权失效） |
| `DATABASE_URL` | PostgreSQL 异步连接串（asyncpg） |
| `REDIS_URL` | Redis 连接串 |
| `LLM_API_KEY` / `LLM_BASE_URL` | 百炼 DashScope 凭证与兼容端点 |
| `EMBEDDING_MODEL` | 嵌入模型（需与 `rule_documents.embedding` 向量维度一致，默认 1536） |
| `AGENT_ENABLED` / `MEMORY_DISTILL_ENABLED` / `ANSWER_CACHE_ENABLED` | 功能与成本开关 |

---

## 🧪 质量保障

- **零数据虚构原则**：无来源字段如实标注、不估算。
- `regression_rag.py`：检索与问答链路回归脚本，保障改动无退化。
- 同列向量禁混模型，换嵌入模型须全量重算（`reembed_all.py`）。

---

## 📄 许可证

本项目仅供学习与演示。游戏封面等素材版权归原作者所有。
