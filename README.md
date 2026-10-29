# TableMind · 桌游信息与 AI 智能问答平台

> 独立全栈项目：桌游信息库 + 玩家社区 + AI 智能助手（定位类似国内版 BoardGameGeek）。

TableMind 是一个一体化 Web 平台，覆盖**用户端**与**管理员端**双应用：提供桌游库检索、评分评测、社区交流，并基于 RAG（检索增强生成）与 Agent 实现规则书智能问答、对话式个性化推荐。

---

## ✨ 功能特性

- **桌游信息库**：47 款桌游的结构化数据（类型、机制、人数、时长、难度等），支持多维筛选与检索；封面等静态资源随库提供。
- **评分评测与社区**：用户收藏（想玩 / 玩过 / 拥有）、评分评测、社区发帖与评论。
- **规则书 RAG 智能问答**：说明书中文化清洗 → 切分 → 向量化入库；答案附带规则书引用来源，模型降级时仍返回规则原文、**永不空答**。规则语料不随仓库分发，需登录管理端上传。
- **Agent 对话式推荐**：三级路由（关键词优先 → 追问沿用历史 → LLM 兜底）+ 规则问答 / 个性化推荐双流水线；分层记忆（短期会话 + 长期用户画像）支撑多轮上下文；人数区间、时长上下限等槽位化筛选与流式输出。
- **管理端**：桌游维护、标签管理、用户管理、内容审核、规则文档管理，基于 ECharts 的数据看板（核心指标卡片 + 近 30 天趋势），以及 **RAG 四维评测中心**（用例库 + 批量跑批 + LLM 裁判 + badcase 定位）与 **系统配置中心**（在线调参、即时生效、变更审计与回滚）。
- **质量评测（P3）**：LLM-as-judge 从 Context Recall / Context Precision / Faithfulness / Answer Relevance 四个维度给线上真实链路打分（检索 → 生成 → 裁判），输出批次均值、通过率与层级分布；改动检索或模型后跑同一题库即可做回归对比。

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python · FastAPI · SQLAlchemy 2.0（全异步 asyncpg）· Alembic |
| 数据库 / 缓存 | PostgreSQL + **pgvector** 向量扩展 · Redis |
| 鉴权 | JWT 无状态（用户名 / 手机号双通道登录，USER / ADMIN 角色隔离） |
| AI / 大模型 | 百炼 DashScope（OpenAI 兼容端点）· `text-embedding-v1`（1536 维）· LangChain · RAG · Agent |
| 检索 | 查询改写 + 向量 + **BM25（jieba / 二元组）** 混合检索，可切换 RRF / 归一化加权融合，**gte-rerank-v2** 精排，**父子分块回填**；支持 HyDE；hit@5 ≈ 96% |
| 评测 | LLM-as-judge 四维评分（Context Recall / Precision、Faithfulness、Answer Relevance），用例库快照 + 批次回归 + 通过率门禁 |
| 前端 | React 18 · TypeScript · Ant Design · Vite · ECharts |

---

## 📁 目录结构

```
TableMind/
├── backend/                 # FastAPI 后端
│   ├── alembic/             # 数据库迁移
│   ├── data/                # 桌游目录 / 规则书等种子数据
│   ├── seed_*.py            # 初始化脚本（管理员 / 桌游 / 社区 / 资讯）
│   └── app/
│       ├── api/             # 路由（user / admin）
│       ├── agent/           # AI 管线（rag / router / loop / recommend / memory / llm / pool ...）
│       ├── core/            # 配置 / 安全 / 数据库 / 依赖
│       └── models/          # ORM 模型
├── frontend/                # React + Vite 前端
│   ├── src/
│   └── public/              # 静态资源（游戏封面 / 规则书页面图等）
├── local-env/               # 便携 PostgreSQL + pgvector + Redis（不入版本库）
│   ├── pgsql/               # PostgreSQL 16.4 二进制
│   ├── pgdata/              # 数据目录（initdb 生成）
│   ├── redis/               # Redis 5.0 二进制
│   ├── start-env.bat        # 启动 PostgreSQL + Redis
│   └── stop-env.bat         # 停止 PostgreSQL + Redis
├── logs/                    # 运行日志
├── .env.example             # 环境变量模板（复制为 .env 后填写）
└── docker-compose.yml       # 容器版 PG + Redis（可选）
```

---

## 🚀 快速开始

### 1. 启动依赖服务

项目自带便携运行环境，位于项目内 `local-env/`（PostgreSQL 16.4 + pgvector 0.8.7 + Redis 5.0），**无需安装 Docker 或系统级数据库**：

```powershell
.\local-env\start-env.bat      # 启动 PostgreSQL(5432) + Redis(6379)，已在运行则跳过
.\local-env\stop-env.bat       # 停止两者
```

便携库的默认凭据：用户名 / 密码 / 库名均为 `tablemind`，与 `.env.example` 中的 `DATABASE_URL` 保持一致。

> 也可改用 `docker-compose up -d` 启动容器版 PostgreSQL（含 pgvector）与 Redis，只需保证 `DATABASE_URL` 与 `REDIS_URL` 可达，并已启用 `pgvector` 扩展。
>
> `local-env/` 体积约 1GB，已在 `.gitignore` 中忽略；若目录丢失或换机，见下文「便携环境重建」。

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入 SECRET_KEY、LLM_API_KEY、数据库连接等
```

### 3. 后端

```bash
cd backend
pip install -r requirements.txt        # 或所用依赖管理
alembic upgrade head                   # 建表（迁移会自动 CREATE EXTENSION vector）
PYTHONPATH=. uvicorn app.main:app --host 0.0.0.0 --port 8000
```

> 若使用非 pgvector 官方镜像的 PostgreSQL，请先在目标库执行 `CREATE EXTENSION vector`（需实例已安装 pgvector 扩展包），否则迁移报 `type "vector" does not exist`。

### 4. 初始化数据（管理员 + 桌游库 + 社区）

```bash
cd backend
python seed_admin.py                   # 创建管理员账号 admin（幂等）
python seed_catalog.py                 # 导入 47 款桌游（数据来自 data/catalog.json，幂等）
python seed_community_refresh.py       # 社区帖子 / 评论 / 玩家账号（会先清空社区表）
python seed_reviews.py                 # 5 位玩家的评分与短评（依赖上一步的玩家账号）
python seed_official_news.py           # 官方资讯帖
python seed_rulebooks.py               # 规则语料：扫描页 OCR + 切片 + 向量化（耗时，可选）
```

> **规则问答语料**（切片文本与向量）不随仓库分发，但规则书扫描页已随仓库放在 `frontend/public/rules/`：运行 `python seed_rulebooks.py` 会逐页 OCR → 切片 → 向量化重建（OCR 结果缓存在 `logs/rule_ocr/`，中断可续跑）。也可以在管理端上传 PDF/图片后点「从规则书生成」。

### 5. 前端

```bash
cd frontend
npm install
npm run dev                            # 开发服务器默认 http://localhost:5173
```

前端通过 `/api` 代理到后端 `:8000`。

---

## 🧩 便携环境重建（local-env）

`local-env/` 不入版本库，若目录被删或换机，按下面步骤重建（Windows，无需管理员权限，无需 Docker）：

1. 下载 [PostgreSQL 16 便携包](https://www.enterprisedb.com/download-postgresql-binaries)，解压到 `local-env\pgsql`。
2. 初始化数据目录（按提示输入两次密码，例如 `tablemind`）：

```powershell
.\local-env\pgsql\bin\initdb.exe -D .\local-env\pgdata -U tablemind -W -E UTF8 --locale=C
```

3. 安装 pgvector：把 `vector.dll` 放入 `local-env\pgsql\lib`，把 `share\extension\vector*` 放入 `local-env\pgsql\share\extension`（须为 PG16 版本，如 `vector.v0.8.7-pg16`）。
4. 把 Redis for Windows 解压到 `local-env\redis`。
5. 启动环境、建库并启用扩展：

```powershell
.\local-env\start-env.bat
.\local-env\pgsql\bin\createdb.exe -U tablemind -h localhost tablemind
.\local-env\pgsql\bin\psql.exe -U tablemind -h localhost -d tablemind -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

6. 迁移与种子数据（在 `backend` 目录）：

```powershell
alembic upgrade head
python seed_admin.py
python seed_catalog.py
python seed_community_refresh.py
python seed_reviews.py
python seed_official_news.py
python seed_rulebooks.py               # 规则语料（逐页 OCR，约 40 分钟以上）
```

> ⚠️ `local-env\pgdata` 是唯一的数据载体，删除即等于清库，迁移或清理时请勿误删。误删后可用上面这几个种子脚本恢复桌游、账号、社区与评分，再跑 `seed_rulebooks.py` 重建规则语料；历史会话与评测用例没有备份，无法恢复。

---

## 🔑 环境变量

复制 `.env.example` 为 `.env` 并填写。关键项：

| 变量 | 说明 |
|------|------|
| `SECRET_KEY` | JWT 签名密钥，**必须设为强随机值**（占位符会导致鉴权失效） |
| `DATABASE_URL` | PostgreSQL 异步连接串（asyncpg） |
| `REDIS_URL` | Redis 连接串 |
| `LLM_API_KEY` / `LLM_BASE_URL` | 百炼 DashScope 凭证与兼容端点 |
| `LLM_MODEL` / `LLM_FALLBACK_MODELS` | 主模型与降级链：主模型 403/429（额度、限流）时按顺序自动切换，避免整站降级成检索文案 |
| `EMBEDDING_MODEL` | 嵌入模型（需与 `rule_documents.embedding` 向量维度一致，默认 1536） |
| `AGENT_ENABLED` / `MEMORY_DISTILL_ENABLED` / `ANSWER_CACHE_ENABLED` | 功能与成本开关 |
| `RAG_FUSION` / `RAG_VECTOR_WEIGHT` / `RAG_BM25_WEIGHT` | 融合方式（score / rrf）与两路权重 |
| `RAG_VECTOR_POOL` | 每路查询在 pgvector（HNSW）取多少个 Top-N 候选参与融合 |
| `RAG_BM25_TOKENIZER` / `RAG_QUERY_EXPAND_ENABLED` / `HYDE_ENABLED` | BM25 分词（auto / jieba / bigram）、查询改写、HyDE 开关 |
| `RERANK_ENABLED` / `RERANK_TOP_N` / `RERANK_METHOD` | 检索精排：默认 `gte`（gte-rerank-v2），可切 `llm` / `score`；异常自动回落 |
| `PARENT_FILL_ENABLED` / `PARENT_MAX_CHARS` | 父子分块回填：命中子片后返回所属父章节全文（限长、同父去重） |
| `EVAL_JUDGE_MODEL` / `EVAL_JUDGE_TEMPERATURE` | 评测裁判模型（留空跟随 `LLM_MODEL`）与温度（默认 0，保证同批可比） |
| `EVAL_CONCURRENCY` / `EVAL_PASS_THRESHOLD` / `EVAL_ANSWER_MAX_TOKENS` | 评测并发条数、单条 overall 通过阈值、评测生成长度兜底 |

---

## 🧪 质量保障

- **零数据虚构原则**：无来源字段如实标注、不估算。
- 同列向量禁混模型，换嵌入模型须全量重算（管理端 `POST /api/admin/games/{id}/rule-docs/reembed`）。
- **四维评测回归**：管理端「评测中心」维护用例（问题 + 按规则书整理的标准答案 + 可选标准切片），一键跑批。评测复用线上真实链路（分层检索 → 生成 → 裁判），结果落库并冗余保存问答快照，用例即使删除历史批次仍可复核；无参考答案的用例不计算 Context Recall，裁判失败写 `error` 且不参与均值，避免污染分数。
- 每批结果给出四指标均值、通过率（默认 overall ≥ 0.6）与检索层级分布，默认按总分升序排列，便于直接定位 badcase。

---

## ⚙️ 运行时配置中心

管理端「系统配置」把检索、生成、评测的关键参数从 `.env` 搬到页面上，**保存后立即作用于当前后端进程，无需重启**。

- **白名单**：只登记请求时读取的运行参数（融合方式、重排方式、HyDE、父子回填、模型、评测阈值等）；API Key、`DATABASE_URL` 这类敏感/结构性配置永远只能走 `.env`。
- **覆盖与回落**：数据库只存被改过的键，其余继续读 `.env`；「恢复默认」删除覆盖并回到启动时捕获的 `.env` 值。
- **变更审计**：每次修改 / 恢复默认 / 回滚都记录操作人、旧值、新值，可在页面按参数查看并一键回滚到任一历史取值。
- **与评测联动**：P3 批次会记录生成时的配置快照（融合方式、重排方式、模型、Top-K 等），因此「改配置 → 跑评测 → 对比四维分 → 保留或回滚」构成完整闭环。
- 当前实现面向**单进程部署**：写接口直接改写进程内 `settings`。多进程/多副本部署需要额外加广播或定期同步，否则各进程配置会不一致。

---

## 📄 许可证

本项目仅供学习与演示。游戏封面等素材版权归原作者所有。
