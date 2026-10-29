from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置，从 .env 文件读取（字段与根目录 .env.example 对应）"""

    DATABASE_URL: str = "postgresql+asyncpg://tablemind:tablemind@localhost:5432/tablemind"
    REDIS_URL: str = "redis://localhost:6379/0"

    SECRET_KEY: str = "change-me-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080
    ALGORITHM: str = "HS256"

    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = "https://api.deepseek.com/v1"
    # 2026-10-29：换用 DeepSeek 平台（官方 OpenAI 兼容端点），可用模型 deepseek-v4-pro /
    # deepseek-flash。该端点没有 embedding / rerank / OCR 能力，这几项继续走百炼
    # DashScope（见下方 DASHSCOPE_*）。注意 V4 默认开启思维链（effort=high），
    # 小 max_tokens 会被思维链吃光导致正文为空，故 LLM_MAX_TOKENS 保持 8000。
    LLM_MODEL: str = "deepseek-v4-pro"
    # 统一输出：不再限制回答长度，这里只作为未显式传 max_tokens 时的兜底上限
    LLM_MAX_TOKENS: int = 8000
    # 主模型额度耗尽/被限流时，按顺序自动尝试的备用模型（逗号分隔）。
    # 这样免费额度用尽不会全站降级成检索文案，只会在日志里留一条切换记录。
    LLM_FALLBACK_MODELS: str = "deepseek-flash"
    LLM_TIMEOUT: int = 90
    # 百炼 DashScope：仅用于 embedding / rerank / 规则书图片 OCR。
    # DeepSeek 端点不具备这些能力，故单独保留一套密钥与地址。
    DASHSCOPE_API_KEY: str = ""
    DASHSCOPE_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    # 百炼兼容嵌入模型；维度必须与 rule_documents.embedding 的 Vector(N=1536) 一致。
    # text-embedding-v1 默认 1536 维（与列一致，且当前免费额度可用）；
    # v2/v4 免费额度已耗尽（AllocationQuota.FreeTierOnly），v3 只到 1024（与列不匹配，勿用）。
    EMBEDDING_MODEL: str = "text-embedding-v1"
    # 显式输出维度；v1 默认就是 1536，传了也兼容（v4 默认不是 1536 时必须传）。
    EMBEDDING_DIM: int | None = 1536
    # 是否启用 Agent 工具调用循环（关闭则退回固定的 RAG 工作流，行为与改造前一致）
    AGENT_ENABLED: bool = True
    # 是否启用「LLM 主 Agent 编排」：在确定性 Router 之上再套一层 LLM Orchestrator，
    # 由 LLM 决定派发 1 个或 2 个副 Agent（规则/推荐），支持复合意图。
    # 关闭则直接走确定性 Router（行为与升级前一致）。任何失败都会回落到确定性 Router。
    AGENT_ORCHESTRATOR_ENABLED: bool = True
    # 规则问答的 L3「BGG 社区共识」层开关。
    # 实测 boardgamegeek.com/xmlapi2 返回 401（已强制鉴权），拿不到数据，
    # 故默认关闭——没数据就绝不允许编。拿到可用鉴权并实现抓取后再打开。
    RULE_BGG_LAYER_ENABLED: bool = False
    # 是否在每次对话后自动蒸馏用户偏好到画像/情景记忆（best-effort，失败不影响主回复）。
    # 关闭则只保留显式 PUT /ai/memory 写入的偏好；开启会每轮额外消耗一次轻量 LLM 调用。
    MEMORY_DISTILL_ENABLED: bool = True
    # 对话状态（LangGraph AsyncPostgresStore 承载）：跨轮维护话题游戏与实体上下文，
    # 追问"那掷出 7 但没资源呢"时自动补上上一轮的游戏与问题语境用于检索。
    # 存取全程 best-effort：未启用或初始化失败时降级为空状态，不影响主流程。
    DIALOGUE_STATE_ENABLED: bool = True

    # ---- Agentic RAG 状态图 ----
    # rewrite → retrieve → grade →（不足且未到上限则重试；到上限则 fallback）
    # → generate → check →（不通过且未到上限则重生成）→ END。
    # 任一环节异常由 rule_qa 回落到旧流水线，因此默认可开。
    AGENTIC_RAG_ENABLED: bool = True
    # 检索不足时的最大检索次数（含首次）；达到后走 fallback 降级。
    AGENTIC_MAX_RETRIES: int = 3
    # 幻觉检查不通过时的最大检查次数；达到后保留回答并追加「以官方说明书为准」提示。
    AGENTIC_MAX_CHECK_RETRIES: int = 2
    # 是否启用生成后的事实核查（LLM-as-judge）。关闭则只保留检索充分性判断。
    AGENTIC_CHECK_ENABLED: bool = True
    # L1 结构化资料是否再用 LLM 判定「是否足以回答」；默认关闭以控制首字延迟。
    AGENTIC_GRADE_LLM_ENABLED: bool = False

    # ---- 工程化：延迟与成本治理 ----
    # 规则问答/改写是否使用独立模型（建议配一个「非推理」模型以获得更低首字延迟）；
    # 为空则沿用 LLM_MODEL。配合下方 LLM_RULE_THINKING 关闭思维链。
    LLM_RULE_MODEL: str | None = None
    # 轻量辅助调用专用模型：意图路由、检索充分性判定、事实核查、查询改写、记忆蒸馏。
    # DeepSeek V4 默认带思维链，这些短任务用大模型每次要多等 3~5 秒且小 token
    # 预算会被思维链吃光，故默认统一压到速度档。
    LLM_FAST_MODEL: str = "deepseek-flash"
    # 规则问答生成是否保留推理思维链。False=关闭（知识检索型任务不需要，首字更快）；
    # True=保留（更稳但慢）。若模型不支持 enable_thinking，置 True 以免请求被拒。
    LLM_RULE_THINKING: bool = False
    # 热点答案缓存：高频/近似重复的规则问题直接返回，首字延迟≈0
    ANSWER_CACHE_ENABLED: bool = True
    ANSWER_CACHE_TTL_SEC: int = 86400
    ANSWER_CACHE_SIMILARITY: float = 0.93  # embedding 余弦≥此值视为同一问题（近似命中）
    # 灰度：按概率把流量从 Agent(路由+流水线) 切到固定 RAG 路径，用于对比延迟/准确率
    # 0=全走 Agent，1=全走固定 RAG
    AI_CANARY_RATIO: float = 0.0
    # ---- Advanced RAG：混合检索 / 查询增强 / 重排 ----
    # 融合方式："score"=两路各自归一化后加权（默认，实测更稳，领先幅度不被名次抹平）；
    # "rrf"=Reciprocal Rank Fusion（只看名次，对两路量纲不敏感，适合跨模型/跨库融合）。
    RAG_FUSION: str = "score"
    RAG_VECTOR_WEIGHT: float = 1.0
    RAG_BM25_WEIGHT: float = 1.6
    # 每路查询在 pgvector 里取多少个 Top-N 候选参与融合（走 HNSW 索引）。
    # 单款游戏切片通常不足 40 段，默认 60 可覆盖全部；超过时池外切片按 0 分处理，
    # 仍可被 BM25 路召回。
    RAG_VECTOR_POOL: int = 60
    # BM25 中文分词："auto"=装了 jieba 就用（否则二元组）；"jieba"；"bigram"。
    # jieba 切出真实词边界，稀有专有词（如「钱币」「磁砖」）召回优于二元组；
    # 未安装/初始化失败自动回落二元组，不影响检索可用性。
    RAG_BM25_TOKENIZER: str = "auto"
    # 查询改写（口语 → 规则书措辞）：每轮多一次轻量 LLM 调用，实测显著提升真实用户措辞命中率
    RAG_QUERY_EXPAND_ENABLED: bool = True
    # HyDE：先让 LLM 生成一段「假设的规则书原文」，只把它加进**向量路**做检索。
    # 不加进 BM25 路——假设文本里的幻觉词会污染字面召回。失败/为空时自动跳过。
    HYDE_ENABLED: bool = False
    HYDE_MAX_TOKENS: int = 400
    HYDE_TEMPERATURE: float = 0.3
    # 重排（Rerank）阶段：在混合检索融合之后、取 Top-K 之前再精细排序。
    # gte=百炼 gte-rerank-v2 语义重排（真实 cross-encoder 分数，一次 HTTP 调用）；
    # llm=大模型点式打分（较慢）；score=按融合分重排（零额外调用）。
    # 任何异常都回落融合顺序，最坏情况只是「没重排」，不影响回答正确性。
    RERANK_ENABLED: bool = True
    RERANK_TOP_N: int = 15
    RERANK_METHOD: str = "gte"
    RERANK_MODEL: str = "gte-rerank-v2"
    RERANK_BASE_URL: str = (
        "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank"
    )
    RERANK_TIMEOUT: int = 20
    # 父子分块回填：子片负责匹配，命中后用所属父章节（更完整的上下文）交给模型。
    # 历史切片没有父片信息时自动回落到子片正文，不影响可用性。
    PARENT_FILL_ENABLED: bool = True
    PARENT_MAX_CHARS: int = 1600
    # ---- P3：四维评测（LLM-as-judge）----
    # 裁判模型留空则跟随 LLM_MODEL；评测是离线的，模型可比线上更强/更便宜。
    EVAL_JUDGE_MODEL: str = ""
    EVAL_JUDGE_MAX_TOKENS: int = 1200
    EVAL_JUDGE_TEMPERATURE: float = 0.0
    # 评测生成答案的 token 上限：评测要复现真实回答，故与线上统一口径
    EVAL_ANSWER_MAX_TOKENS: int = 6000
    # 批量评测并发数：过高会触发百炼限流（RPM），默认 2
    EVAL_CONCURRENCY: int = 2
    # 单条用例判为「通过」的总分阈值（四指标均分，0~1）
    EVAL_PASS_THRESHOLD: float = 0.6
    # 是否在日志里记录每次 LLM 调用的 token 用量（用于成本计量）
    LLM_LOG_USAGE: bool = True

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()

import logging

_log = logging.getLogger(__name__)
if settings.SECRET_KEY == 'change-me-in-production':
    _log.critical(
        'SECRET_KEY 仍是默认值 change-me-in-production！任何人都可伪造 JWT，鉴权形同虚设；'
        '请立即在 .env 中设置一个强随机值。'
    )
