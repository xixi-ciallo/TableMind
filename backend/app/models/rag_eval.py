"""P3 评测数据模型：评测用例 → 评测批次 → 单条结果。

为什么不复用线上聊天记录：
- 线上记录没有「标准答案」，无法算 Context Recall；也无法保证同一批用例在
  改动前后可重复运行。评测用例是**稳定题库**，跑分才有可比性。
- 结果里冗余保存 question / reference_answer / answer 快照：用例后续被改写或
  删除，历史批次仍然可读、可对比。
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EvalCase(Base):
    """一条评测用例（问题 + 参考答案 + 可选的标准切片）。"""

    __tablename__ = "rag_eval_cases"

    id: Mapped[int] = mapped_column(primary_key=True)
    # 指定游戏可让检索直接走该游戏的规则书；为空则按问题自动识别
    game_id: Mapped[int | None] = mapped_column(
        ForeignKey("board_games.id", ondelete="SET NULL"), index=True, nullable=True
    )
    question: Mapped[str] = mapped_column(Text)
    # 参考答案用于 Context Recall；为空时该指标不参与打分（不臆造标准）
    reference_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 人工标注的标准切片序号（可选，便于人工复核与后续做确定性检索指标）
    reference_chunks: Mapped[list[int] | None] = mapped_column(JSON, nullable=True)
    tags: Mapped[str | None] = mapped_column(String(120), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EvalRun(Base):
    """一次批量评测（同一配置下跑完整题库）。"""

    __tablename__ = "rag_eval_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    # pending / running / completed / failed
    case_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, default=0)
    # 快照：融合方式 / 分词 / 重排 / 父块回填 / 生成与裁判模型，便于解释分数差异
    config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 汇总：四指标均值、通过率、低分条数
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class EvalResult(Base):
    """单条用例的评测结果：检索层级、生成答案、四维分数与裁判理由。"""

    __tablename__ = "rag_eval_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("rag_eval_runs.id", ondelete="CASCADE"), index=True
    )
    # 用例删除后结果仍保留（SET NULL），保证历史批次可回看
    case_id: Mapped[int | None] = mapped_column(
        ForeignKey("rag_eval_cases.id", ondelete="SET NULL"), index=True, nullable=True
    )
    game_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    question: Mapped[str] = mapped_column(Text)
    reference_answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    level: Mapped[int | None] = mapped_column(Integer, nullable=True)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    contexts: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    citations: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)

    # 四维分数统一归一化到 0~1；None 表示该指标本次无法评估（如缺参考答案）
    context_recall: Mapped[float | None] = mapped_column(Float, nullable=True)
    context_precision: Mapped[float | None] = mapped_column(Float, nullable=True)
    faithfulness: Mapped[float | None] = mapped_column(Float, nullable=True)
    answer_relevance: Mapped[float | None] = mapped_column(Float, nullable=True)
    overall: Mapped[float | None] = mapped_column(Float, nullable=True)
    judge_reasons: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
