# TableMind 桌游系统设计方案

## 一、项目概述

**TableMind** 是一个「桌游信息库 + 玩家社区 + AI 智能助手」的 Web 系统，定位类似国内版的 BoardGameGeek（BGG）。系统分为两端：

- **用户端**：面向普通玩家，提供桌游浏览/搜索、评分评测、社区交流、个人收藏、AI 助手。
- **管理端**：面向运营管理员，提供桌游数据维护、规则文档管理（AI 问答的数据源）、用户管理、内容审核、数据统计。

AI 智能助手基于 LangChain 构建，核心职责是**桌游规则问答**（RAG 检索说明书作答）和**个性化桌游推荐**（Agent 对话式推荐）。

## 二、功能模块清单

### 2.1 用户端

| 模块 | 功能点 |
|---|---|
| 首页 | 热门桌游榜、最新评测、社区精选帖子、AI 助手入口 |
| 桌游库 | 桌游列表（分页）；按关键词搜索；按人数 / 时长 / 复杂度 / 分类 / 机制多条件筛选；按评分 / 热度排序 |
| 桌游详情 | 基础信息（人数、时长、年龄、复杂度、出版信息）、分类与机制标签、社区均分与评分分布、评测列表、相关帖子、AI 问答入口（"问问这款游戏的规则"） |
| 评分评测 | 对桌游打 1~10 分并撰写评测；查看他人评测；点赞有用评测 |
| 社区 | 帖子列表（可按关联桌游过滤）；发帖 / 编辑 / 删除自己的帖子；评论与回复 |
| 个人中心 | 个人资料修改；我的收藏（想玩 / 玩过 / 拥有三个清单）；我的评测；我的帖子；AI 对话历史 |
| 认证 | 注册、登录、退出；JWT 无状态鉴权 |
| AI 助手 | 对话式交互：桌游规则问答（附引用来源）；个性化推荐（说明推荐理由）；多轮对话上下文；流式输出 |

### 2.2 管理端

| 模块 | 功能点 |
|---|---|
| 管理员登录 | 独立登录入口，仅 `role=admin` 账号可进入 |
| 数据仪表盘 | 核心指标卡片（用户数、桌游数、评测数、帖子数、AI 调用量）；近 30 天趋势图 |
| 桌游管理 | 桌游的增 / 删 / 改 / 查；封面上传；分类与机制标签维护 |
| 规则文档管理 | 上传桌游说明书（PDF / 文本）；触发文本切分与向量化入库；查看每款游戏的切片状态与数量（RAG 数据源管理） |
| 用户管理 | 用户列表与搜索；禁用 / 启用账号 |
| 内容审核 | 评测 / 帖子 / 评论列表；删除违规内容 |
| 标签管理 | 分类（如德式 / 美式 / 聚会）与机制（如卡牌构筑 / 工人放置）标签的增删改 |

### 2.3 两端职责边界

- 用户端**只读**桌游数据，写操作仅限自己产生的内容（评测、帖子、收藏）。
- 管理端**不展示**社区交互界面，专注数据维护与审核。
- 两端共享同一后端，通过 **JWT 中的角色字段**做接口级权限隔离：管理接口统一挂在 `/api/admin/*`，由 FastAPI 依赖注入校验管理员角色。

## 三、技术选型与解释

| 层 | 技术 | 选择原因 |
|---|---|---|
| 后端 | **FastAPI** | ① 原生异步（async/await），高并发下性能好；② 基于 Pydantic 自动做请求/响应校验，并自动生成 Swagger 接口文档，前后端联调成本低；③ 与 LangChain 同属 Python 生态，AI 能力可直接嵌入后端，无需跨语言调用 |
| 前端 | **React 18 + Vite**（单工程双站点） | ① Vite 冷启动和热更新极快；② React 生态成熟，配合 **Ant Design** 可快速搭建信息库、社区和后台管理界面；③ 用户端与管理端放在**同一前端工程**（`/admin` 路由组 + 角色路由守卫 + 独立布局），共享组件、类型和 API 封装，比拆两个仓库维护成本低 |
| 主数据库 | **PostgreSQL** | ① **JSONB** 适合存桌游灵活属性（分类、机制标签数组）；② 内置全文检索，直接支撑桌游搜索；③ 通过 **pgvector** 扩展直接存储向量，作为 RAG 向量库，**省掉独立部署 Milvus/Chroma 的复杂度** |
| 缓存 | **Redis** | ① 热门桌游、排行榜等读多写少数据缓存；② AI 多轮对话会话上下文缓存；③ 接口限流 |
| AI 框架 | **LangChain** | ① 提供现成 RAG 链路组件（文档加载 → 切分 → Embedding → 向量检索 → LLM 生成）；② Agent + Tools 机制便于实现对话式推荐；③ 与 pgvector、主流大模型（OpenAI / 通义 / DeepSeek 等）均有现成集成 |
| ORM | SQLAlchemy 2.0 + Alembic | FastAPI 官方推荐搭档，Alembic 管理数据库迁移 |
| 鉴权 | JWT（python-jose）+ bcrypt，令牌含 `role` 字段 | 无状态登录；同一套令牌同时支撑用户端与管理端，接口按角色隔离 |
| 部署 | Docker Compose | 一键拉起 PostgreSQL / Redis / 后端 / 前端 |

### 关键选型说明

1. **为什么 PostgreSQL 能同时当"业务库 + 向量库"？** AI 规则问答需要向量检索。pgvector 是 PostgreSQL 官方扩展，在本项目数据量（万级文档片段）下性能完全够用，避免引入独立向量数据库的部署运维成本。

2. **为什么推荐功能用 LangChain Agent 而不是写死逻辑？** 推荐场景是开放式的（"我想找一款 4 人、30 分钟、不太烧脑的聚会游戏"）。Agent 让大模型理解需求后**自主调用工具**（如 `search_games(人数, 时长, 复杂度)`）查库，再组织语言推荐并附理由，比硬编码筛选规则灵活得多。

3. **为什么管理端与用户端共用一个前端工程？** 两端都用 React + Ant Design，共享类型定义、API 封装和部分组件（表格、表单、上传）。通过路由分组（`/` 用户端、`/admin` 管理端）+ 布局分离 + 路由守卫即可实现体验上的"两端分离"，同时避免维护两套构建配置。

4. **前后端如何通信？** 常规业务走 RESTful JSON API；AI 对话走 **SSE（Server-Sent Events）流式接口**，实现逐字输出。

## 四、系统架构

```
┌─────────────────────────┐   ┌─────────────────────────┐
│ 用户端站点 React + AntD  │   │ 管理端站点 React + AntD  │
│ 桌游库/社区/个人中心/AI  │   │ 仪表盘/桌游/审核/规则文档 │
└───────────┬─────────────┘   └───────────┬─────────────┘
            │ REST / SSE                   │ REST（管理员角色）
┌───────────▼──────────────────────────────▼─────────────┐
│ 后端  FastAPI                                           │
│  ├─ 用户 API：认证/桌游/评测/帖子/评论/收藏             │
│  ├─ 管理 API：统计/桌游管理/审核/用户管理/规则文档      │
│  └─ AI 智能体（LangChain）                              │
│      ├─ RAG 问答链：规则说明书 → 向量检索 → 生成答案    │
│      └─ 推荐 Agent：LLM + 工具调用（查库/查收藏）       │
└──────┬───────────────────────────────┬──────────────────┘
       │                               │
┌──────▼───────────────┐     ┌─────────▼────────┐
│ PostgreSQL + pgvector │     │ Redis            │
│ 业务数据 + 规则向量    │     │ 缓存 / AI 会话    │
└──────────────────────┘     └──────────────────┘
```

## 五、数据库设计（核心表）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | id, username, email, password_hash, **role**(user/admin), avatar, is_active, created_at | 用户；role 区分普通用户与管理员 |
| `board_games` | id, name, name_en, description, cover_image, min_players, max_players, play_time_minutes, min_age, complexity(1~5), categories(JSONB), mechanics(JSONB), publisher, year_published, avg_rating, rating_count | 桌游主表 |
| `game_tags` | id, name, type(category/mechanic) | 分类与机制标签，由管理端维护 |
| `reviews` | id, user_id, game_id, rating(1~10), content, like_count, created_at | 评分与评测（一人对一游戏一条） |
| `posts` | id, user_id, game_id(可空), title, content, created_at | 社区帖子 |
| `comments` | id, post_id, user_id, parent_id(可空), content, created_at | 评论，parent_id 支持回复 |
| `collections` | id, user_id, game_id, status(want/played/owned), created_at | 个人收藏 |
| `rule_documents` | id, game_id, chunk_index, content, embedding(vector) | 规则说明书片段（RAG 数据源，pgvector） |
| `chat_sessions` / `chat_messages` | session 与用户关联；message 记录角色与内容 | AI 对话历史 |

## 六、AI 智能体设计（LangChain）

### 6.1 规则问答（RAG Chain）

数据源由**管理端**上传维护：

```
管理员上传说明书 PDF/文本 → 文本切分(Chunking) → Embedding → 存入 pgvector
                                                                    │
用户提问「璀璨宝石几人局最优？」→ 问题 Embedding → 相似度检索 Top-K 片段
                                                                    │
                                              拼接 Prompt → LLM 生成答案
                                              （附带来源片段，流式输出）
```

- Embedding 模型与大模型可接 OpenAI 或国内模型（通义千问 / DeepSeek 等），通过环境变量切换。
- 检索限定在当前桌游的文档范围内（按 game_id 过滤），保证答案不串游戏。

### 6.2 桌游推荐（Agent + Tools）

为 Agent 注册三个工具，由 LLM 自主决策调用：

| 工具 | 功能 |
|---|---|
| `search_games` | 按人数 / 时长 / 复杂度 / 分类 / 关键词查询桌游库 |
| `get_game_detail` | 查询某款桌游的详细信息和社区评分 |
| `get_user_collection` | 查询当前用户收藏，避免推荐已拥有/已玩过的 |

用户说"我们 5 个人聚会，想要 1 小时内、规则简单的游戏"→ Agent 解析条件 → 调用 `search_games` → 结合结果给出 2~3 款推荐及理由。

## 七、API 设计概览

### 7.1 用户端 API

| 路由 | 方法 | 功能 |
|---|---|---|
| `/api/auth/register` `/api/auth/login` | POST | 注册 / 登录（返回 JWT） |
| `/api/games` | GET | 桌游列表（关键词、人数、时长、复杂度、分类筛选，分页排序） |
| `/api/games/{id}` | GET | 桌游详情 |
| `/api/games/{id}/reviews` | GET / POST | 查看 / 发表评分评测 |
| `/api/posts` `/api/posts/{id}` | GET / POST / PUT / DELETE | 社区帖子 |
| `/api/posts/{id}/comments` | GET / POST | 评论与回复 |
| `/api/collections` | GET / POST / PUT / DELETE | 个人收藏管理 |
| `/api/ai/chat` | POST（SSE） | AI 对话（规则问答 + 推荐，流式返回） |

### 7.2 管理端 API（均需管理员角色）

| 路由 | 方法 | 功能 |
|---|---|---|
| `/api/admin/stats` | GET | 仪表盘统计数据 |
| `/api/admin/games` | POST / PUT / DELETE | 桌游增删改（查询复用用户端接口） |
| `/api/admin/tags` | GET / POST / PUT / DELETE | 分类 / 机制标签管理 |
| `/api/admin/games/{id}/rule-docs` | POST / GET | 上传说明书、查看切片状态；触发向量化 |
| `/api/admin/users` | GET / PUT | 用户列表、禁用 / 启用 |
| `/api/admin/moderation/reviews` `/api/admin/moderation/posts` `/api/admin/moderation/comments` | GET / DELETE | 内容审核与删除 |

## 八、项目目录结构

```
TableMind/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口
│   │   ├── core/                # 配置、安全（JWT + 角色校验）、数据库连接
│   │   ├── models/              # SQLAlchemy 模型
│   │   ├── schemas/             # Pydantic 模型
│   │   ├── api/
│   │   │   ├── user/            # 用户端路由（auth/games/reviews/posts/comments/collections/ai）
│   │   │   └── admin/           # 管理端路由（stats/games/tags/users/moderation/rule_docs）
│   │   ├── services/            # 业务逻辑
│   │   └── agent/               # LangChain：RAG 链、推荐 Agent、工具定义
│   ├── alembic/                 # 数据库迁移
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── user/                # 用户端：页面 + UserLayout
│   │   │   └── pages/           # 首页/桌游库/详情/社区/个人中心/AI助手
│   │   ├── admin/               # 管理端：页面 + AdminLayout
│   │   │   └── pages/           # 登录/仪表盘/桌游管理/规则文档/用户管理/内容审核/标签管理
│   │   ├── shared/              # 共享：API 封装（axios + SSE）、类型定义、通用组件
│   │   ├── stores/              # 状态管理（Zustand）
│   │   └── router.tsx           # 路由 + 角色守卫（/admin 需管理员）
│   └── package.json
├── docker-compose.yml           # PostgreSQL + Redis + 后端 + 前端
└── DESIGN.md                    # 本设计文档
```

## 九、开发路线图

| 阶段 | 目标 |
|---|---|
| 一 | 桌游资料库 + 搜索筛选 + 用户注册登录；管理端桌游 CRUD |
| 二 | 评分评测 + 社区帖子/评论 + 收藏；管理端内容审核与用户管理 |
| 三 | AI 助手：管理端规则文档上传向量化 + 用户端规则问答与推荐 |
| 四 | 部署上线、性能优化（Redis 缓存、分页优化） |

## 十、假设与约定

- 大模型与 Embedding 服务使用外部 API（OpenAI 或国内兼容服务），API Key 通过 `.env` 配置，不硬编码。
- 首个管理员账号通过数据库种子脚本创建，管理端不开放注册。
- 桌游初始数据后续可通过爬虫/公开数据集导入，本阶段只定义表结构。
- 说明书上传与切分脚本归入 AI 阶段实现，骨架中预留 `agent/` 目录、`rule_documents` 表和管理端规则文档路由。
