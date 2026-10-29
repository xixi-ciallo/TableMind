"""P4 运行时配置中心：数据库覆盖 .env，写后即时生效。

设计取舍：
- **白名单**：只有 REGISTRY 里的键允许在线调整，不把整个 Settings 暴露给管理端，
  API Key / DATABASE_URL 这类敏感或结构性配置永远只能走 .env。
- **进程内改写 settings**：所有既有链路读的都是同一个 `settings` 对象，数据库覆盖后
  直接改字段，检索 / 生成 / 评测无需任何改动就能拿到新值。
- **回落 .env**：数据库没有的键使用启动时捕获的 ENV_DEFAULTS，恢复默认即删除覆盖。
- 当前按单进程部署设计（写接口立即改内存）；多进程部署需在写入后重启或加 TTL 同步。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.app_config import AppConfig

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConfigSpec:
    """一个可在管理端调整的参数。group 直接使用中文分组名。"""

    key: str
    group: str
    label: str
    description: str
    # bool / int / float / str / enum
    kind: str
    options: tuple[str, ...] = ()
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    allow_empty: bool = False


# 只登记「请求时读取、改完立即影响线上」的参数；新增参数时同步补到这里即可被管理端看到。
REGISTRY: dict[str, ConfigSpec] = {
    # ---- 检索 ----
    "RAG_FUSION": ConfigSpec(
        key="RAG_FUSION",
        group="检索",
        label="混合检索融合方式",
        description="score=两路归一化后加权（默认）；rrf=按名次融合，对量纲不敏感。",
        kind="enum",
        options=("score", "rrf"),
    ),
    "RAG_VECTOR_WEIGHT": ConfigSpec(
        key="RAG_VECTOR_WEIGHT",
        group="检索",
        label="向量路权重",
        description="score 融合时向量路的权重，越大越偏向语义召回。",
        kind="float",
        minimum=0,
        maximum=10,
        step=0.1,
    ),
    "RAG_BM25_WEIGHT": ConfigSpec(
        key="RAG_BM25_WEIGHT",
        group="检索",
        label="BM25 路权重",
        description="score 融合时字面召回路的权重，越大越偏向关键词命中。",
        kind="float",
        minimum=0,
        maximum=10,
        step=0.1,
    ),
    "RAG_VECTOR_POOL": ConfigSpec(
        key="RAG_VECTOR_POOL",
        group="检索",
        label="向量候选池",
        description="每路查询在 pgvector 取多少个 Top-N 参与融合；池外切片记 0 分，仍可由 BM25 召回。",
        kind="int",
        minimum=10,
        maximum=500,
    ),
    "RAG_BM25_TOKENIZER": ConfigSpec(
        key="RAG_BM25_TOKENIZER",
        group="检索",
        label="BM25 分词器",
        description="auto=装了 jieba 就用，否则二元组；jieba=真实词边界；bigram=二元组降级。",
        kind="enum",
        options=("auto", "jieba", "bigram"),
    ),
    "RAG_QUERY_EXPAND_ENABLED": ConfigSpec(
        key="RAG_QUERY_EXPAND_ENABLED",
        group="检索",
        label="查询改写",
        description="口语问题先改写成规则书措辞再检索，每轮多一次轻量 LLM 调用。",
        kind="bool",
    ),
    "HYDE_ENABLED": ConfigSpec(
        key="HYDE_ENABLED",
        group="检索",
        label="HyDE 查询增强",
        description="先生成假设的规则书原文只喂向量路，失败自动跳过；默认关闭以省调用。",
        kind="bool",
    ),
    "HYDE_MAX_TOKENS": ConfigSpec(
        key="HYDE_MAX_TOKENS",
        group="检索",
        label="HyDE 输出上限",
        description="假设文档的最大 token 数，过大拖慢检索。",
        kind="int",
        minimum=50,
        maximum=2000,
    ),
    "RERANK_ENABLED": ConfigSpec(
        key="RERANK_ENABLED",
        group="检索",
        label="启用重排",
        description="混合检索融合后、取 Top-K 前再精排；异常自动回落融合顺序。",
        kind="bool",
    ),
    "RERANK_METHOD": ConfigSpec(
        key="RERANK_METHOD",
        group="检索",
        label="重排方式",
        description="gte=百炼 gte-rerank-v2（真实 cross-encoder）；llm=点式打分；score=按融合分。",
        kind="enum",
        options=("gte", "llm", "score"),
    ),
    "RERANK_TOP_N": ConfigSpec(
        key="RERANK_TOP_N",
        group="检索",
        label="重排候选数",
        description="进入重排的候选条数，越大越准但耗时越长。",
        kind="int",
        minimum=1,
        maximum=50,
    ),
    "PARENT_FILL_ENABLED": ConfigSpec(
        key="PARENT_FILL_ENABLED",
        group="检索",
        label="父子分块回填",
        description="命中子片后返回所属父章节全文；历史切片无父片信息时自动回落子片。",
        kind="bool",
    ),
    "PARENT_MAX_CHARS": ConfigSpec(
        key="PARENT_MAX_CHARS",
        group="检索",
        label="父块最大长度",
        description="回填父章节的截断长度，过大占用上下文窗口。",
        kind="int",
        minimum=200,
        maximum=6000,
    ),
    # ---- 生成 ----
    "LLM_MODEL": ConfigSpec(
        key="LLM_MODEL",
        group="生成",
        label="默认大模型",
        description="意图路由 / 改写 / 推荐等默认模型；填错会直接导致调用失败，改前请确认账号可用。",
        kind="str",
    ),
    "LLM_RULE_MODEL": ConfigSpec(
        key="LLM_RULE_MODEL",
        group="生成",
        label="规则问答模型",
        description="规则问答与评测生成可单独指定模型；留空跟随默认大模型。",
        kind="str",
        allow_empty=True,
    ),
    "LLM_MAX_TOKENS": ConfigSpec(
        key="LLM_MAX_TOKENS",
        group="生成",
        label="默认输出上限",
        description="未显式传 max_tokens 时的默认值；仅作兜底，不用于限制回答字数。",
        kind="int",
        minimum=256,
        maximum=8000,
    ),
    # ---- 评测 ----
    "EVAL_JUDGE_MODEL": ConfigSpec(
        key="EVAL_JUDGE_MODEL",
        group="评测",
        label="裁判模型",
        description="四维评测的裁判模型；留空跟随默认大模型，可与线上生成模型不同。",
        kind="str",
        allow_empty=True,
    ),
    "EVAL_CONCURRENCY": ConfigSpec(
        key="EVAL_CONCURRENCY",
        group="评测",
        label="评测并发数",
        description="同批次并发条数，过高会触发模型限流。",
        kind="int",
        minimum=1,
        maximum=8,
    ),
    "EVAL_PASS_THRESHOLD": ConfigSpec(
        key="EVAL_PASS_THRESHOLD",
        group="评测",
        label="通过阈值",
        description="单条总分低于该值记为未通过，用于计算批次通过率。",
        kind="float",
        minimum=0,
        maximum=1,
        step=0.05,
    ),
    "EVAL_JUDGE_TEMPERATURE": ConfigSpec(
        key="EVAL_JUDGE_TEMPERATURE",
        group="评测",
        label="裁判温度",
        description="默认 0 保证同批打分可比；调高会增加波动，不建议。",
        kind="float",
        minimum=0,
        maximum=1,
        step=0.1,
    ),
}

# 启动时的 .env 值：数据库没有覆盖、或「恢复默认」时用它
ENV_DEFAULTS: dict[str, Any] = {
    key: getattr(settings, key) for key in REGISTRY if hasattr(settings, key)
}
_missing = [key for key in REGISTRY if key not in ENV_DEFAULTS]
if _missing:  # 注册表写错键名时尽早暴露，避免静默写到一个不存在的属性
    raise RuntimeError(f"运行时配置注册表存在 settings 中不存在的键：{_missing}")

_TRUE = {"1", "true", "yes", "on", "是", "开"}
_FALSE = {"0", "false", "no", "off", "否", "关", ""}


def coerce(spec: ConfigSpec, raw: Any) -> Any:
    """把管理端/数据库里的值转成目标类型，并做范围校验。"""
    if spec.kind == "bool":
        if isinstance(raw, bool):
            return raw
        text = str(raw).strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
        raise ValueError(f"{spec.label} 需要布尔值（true/false）")

    if spec.kind in ("int", "float"):
        try:
            value = int(str(raw).strip()) if spec.kind == "int" else float(str(raw).strip())
        except (TypeError, ValueError):
            raise ValueError(f"{spec.label} 需要{'整数' if spec.kind == 'int' else '数字'}")
        if spec.minimum is not None and value < spec.minimum:
            raise ValueError(f"{spec.label} 不能小于 {spec.minimum}")
        if spec.maximum is not None and value > spec.maximum:
            raise ValueError(f"{spec.label} 不能大于 {spec.maximum}")
        return value

    if spec.kind == "enum":
        text = str(raw).strip().lower()
        if text not in spec.options:
            raise ValueError(f"{spec.label} 只能是：{' / '.join(spec.options)}")
        return text

    text = "" if raw is None else str(raw).strip()
    if not text and not spec.allow_empty:
        raise ValueError(f"{spec.label} 不能为空")
    return text


def serialize(spec: ConfigSpec, value: Any) -> str:
    """落库用的字符串表示（布尔统一 true/false，便于回滚时再解析）。"""
    if spec.kind == "bool":
        return "true" if value else "false"
    return "" if value is None else str(value)


def apply_values(values: dict[str, Any]) -> None:
    """用数据库覆盖值重设整张注册表；没有覆盖的键回到 .env 值。"""
    for key in REGISTRY:
        setattr(settings, key, values.get(key, ENV_DEFAULTS[key]))


def apply_single(key: str, value: Any) -> None:
    setattr(settings, key, value)


def reset_single(key: str) -> None:
    setattr(settings, key, ENV_DEFAULTS[key])


async def load_overrides(db: AsyncSession) -> dict[str, Any]:
    """读取数据库覆盖值；损坏/已下架的键跳过并告警，绝不阻断启动。"""
    rows = (await db.execute(select(AppConfig))).scalars().all()
    values: dict[str, Any] = {}
    for row in rows:
        spec = REGISTRY.get(row.key)
        if spec is None:
            log.warning("运行时配置 %s 已不在注册表中，忽略数据库值", row.key)
            continue
        try:
            values[row.key] = coerce(spec, row.value)
        except ValueError as exc:
            log.warning("运行时配置 %s 的数据库值无效（%s），回落到 .env", row.key, exc)
    return values


async def refresh_runtime_config(db: AsyncSession) -> dict[str, Any]:
    """应用数据库覆盖值，返回实际生效的覆盖项。启动与写入后调用。"""
    values = await load_overrides(db)
    apply_values(values)
    return values
