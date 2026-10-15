# TableMind 桌游信息与 AI 智能问答平台

<div align="right">20XX年XX月 - 20XX年XX月</div>

**独立全栈开发**

- **技术栈**：后端：Python FastAPI、SQLAlchemy 2.0（全异步）、Alembic、PostgreSQL + pgvector 向量扩展、Redis、JWT 无状态鉴权；AI / 大模型：LangChain、百炼 DashScope 大模型（deepseek-v4.1-flash / qwen3.8-flash）、text-embedding-v1（1536 维）、RAG 检索增强生成、Agent 对话式推荐、向量 + BM25 中文二元组混合检索、分层记忆；前端（关键）：React 18 + TypeScript + Ant Design + Vite

- **项目简介**：独立搭建「桌游信息库 + 玩家社区 + AI 智能助手」一体化 Web 平台（定位类似国内版 BoardGameGeek），实现桌游库检索、评分评测、社区交流、规则书 RAG 智能问答、对话式个性化推荐、管理端数据运维等功能，覆盖用户端与管理员端双应用。

- **项目职责**：
  1. **后端架构与全异步服务设计**：基于 FastAPI + SQLAlchemy 2.0 异步引擎构建 RESTful API，异步连接 PostgreSQL（asyncpg），Alembic 管理数据库版本迁移；设计 JWT 无状态认证方案，支持用户名/手机号双通道登录及管理员独立登录入口，通过路由守卫实现 USER / ADMIN 角色权限隔离。
  2. **数据与缓存层设计**：PostgreSQL 持久化核心业务数据，并以 pgvector 扩展存储 1536 维规则书向量；Redis 承担热点数据缓存与评测/榜单加速；实现用户收藏（想玩/玩过/拥有）、评分评测、社区发帖评论，以及管理端桌游维护、标签管理、用户管理、内容审核等业务闭环。
  3. **规则书 RAG 智能问答**：基于 LangChain 搭建 RAG 链路，实现说明书上传→清洗→文本切分→向量化入库全流程（47 款桌游、1300+ 切片全量向量化）；采用「LLM 查询改写 → 向量 + BM25 中文二元组混合检索 → 归一化加权融合（VECTOR_WEIGHT=1.0 / BM25_WEIGHT=1.6 / SECTION_BOOST=2.5）」三段式检索，答案附带规则书引用来源，检索命中率 hit@3 88.9% / hit@5 96.0%。
  4. **Agent 对话式推荐与多轮记忆**：设计「关键词路由优先 → 追问沿用历史 → LLM 兜底」三级路由策略，落地规则问答与个性化推荐双流水线；构建分层记忆体系（短期 ChatSession 近 10 条 + RAG；长期 UserProfile / UserMemoryEpisode 每轮自动蒸馏），支持人数区间、时长上下限等槽位化筛选解析与流式输出，护栏降级策略保证永不空答。
  5. **大模型调用与工程化治理**：选用百炼 DashScope 推理模型（OpenAI 兼容端点，流式 reasoning_content + content 分离，思维链计入 max_tokens），统一模型抽象层；建立降级与缓存开关（AGENT_ENABLED / MEMORY_DISTILL_ENABLED / AI_CANARY_RATIO / ANSWER_CACHE_ENABLED 可配置），同列向量禁混模型、换模型须全量重算，保障嵌入一致性。
  6. **工程质量与部署**：制定零数据虚构原则（无来源字段如实标注、不估算），编写 regression_rag.py 回归脚本验证检索与问答链路；通过 Docker 实现一键部署，前端以 React 18 + TypeScript + Ant Design 构建双端应用，并基于 ECharts 输出管理端数据看板（核心指标卡片 + 近 30 天趋势）。

- **项目成果**：独立完成桌游平台的架构设计、前后端编码、AI 链路调优与部署上线全流程；RAG 规则问答检索命中率 hit@3 达 88.9%、hit@5 达 96.0%，AI 助手实现规则问答与个性化推荐双场景落地，形成可复用的「垂直领域知识库 + Agent」全栈解决方案。
