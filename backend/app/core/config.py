from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置，从 .env 文件读取（字段与根目录 .env.example 对应）"""

    DATABASE_URL: str = "postgresql+asyncpg://tablemind:tablemind@localhost:5432/tablemind"
    REDIS_URL: str = "redis://localhost:6379/0"

    SECRET_KEY: str = "change-me-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080
    ALGORITHM: str = "HS256"

    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    # 原用 deepseek-v4.1-flash；2026-10-14 其免费额度耗尽（AllocationQuota.FreeTierOnly），
    # 同系列的 deepseek-v4-flash-0731、qwen3.8-flash 随后也耗尽（403）。
    # 实测同一账号下 qwen-flash / qwen-plus / qwen-max 仍返回 200，故切换到 qwen-flash
    # （非推理模型：无 reasoning_content、首字更快，支持流式与 function calling）。
    # 充值或关闭「仅使用免费额度」后应改回 deepseek-v4.1-flash 并跑 regression_rag.py 回归。
    LLM_MODEL: str = "qwen-flash"
    # 推理模型的思维链会计入输出额度，上限要给足；当前模型非推理，1600 足够
    LLM_MAX_TOKENS: int = 1600
    LLM_TIMEOUT: int = 90
    # 百炼兼容嵌入模型；维度必须与 rule_documents.embedding 的 Vector(N=1536) 一致。
    # text-embedding-v1 默认 1536 维（与列一致，且当前免费额度可用）；
    # v2/v4 免费额度已耗尽（AllocationQuota.FreeTierOnly），v3 只到 1024（与列不匹配，勿用）。
    EMBEDDING_MODEL: str = "text-embedding-v1"
    # 显式输出维度；v1 默认就是 1536，传了也兼容（v4 默认不是 1536 时必须传）。
    EMBEDDING_DIM: int | None = 1536
    # 是否启用 Agent 工具调用循环（关闭则退回固定的 RAG 工作流，行为与改造前一致）
    AGENT_ENABLED: bool = True
    # 规则问答的 L3「BGG 社区共识」层开关。
    # 实测 boardgamegeek.com/xmlapi2 返回 401（已强制鉴权），拿不到数据，
    # 故默认关闭——没数据就绝不允许编。拿到可用鉴权并实现抓取后再打开。
    RULE_BGG_LAYER_ENABLED: bool = False
    # 是否在每次对话后自动蒸馏用户偏好到画像/情景记忆（best-effort，失败不影响主回复）。
    # 关闭则只保留显式 PUT /ai/memory 写入的偏好；开启会每轮额外消耗一次轻量 LLM 调用。
    MEMORY_DISTILL_ENABLED: bool = True

    # ---- 工程化：延迟与成本治理 ----
    # 规则问答/改写是否使用独立模型（建议配一个「非推理」模型以获得更低首字延迟）；
    # 为空则沿用 LLM_MODEL。配合下方 LLM_RULE_THINKING 关闭思维链。
    LLM_RULE_MODEL: str | None = None
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
    # 可选重排（Rerank）阶段：在混合检索融合之后、取 Top-K 之前再精细排序。
    # 默认关闭——规则化融合在单款游戏规则书切片上已够用；开启会为前 RERANK_TOP_N 段
    # 各调一次 LLM 打分，用于措辞差异大或跨多款游戏的难例纠正。任何异常都回落融合顺序。
    RERANK_ENABLED: bool = False
    RERANK_TOP_N: int = 15
    RERANK_METHOD: str = "llm"  # llm=大模型点式打分；score=调用方已有权重时按分数重排
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
