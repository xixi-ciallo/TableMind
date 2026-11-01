"""Agentic RAG 运行轨迹：agent_run 主记录 + agent_step 节点明细。

一次运行落一条 agent_run（最终层级/降级/核查结果/总耗时），
每个节点落一条 agent_step（节点名/入参摘要/出参摘要/状态/耗时），
用于 badcase 的逐节点回放与性能分析；纯观测设施，不参与回答生成。
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    message: Mapped[str] = mapped_column(Text)
    level: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    fallback: Mapped[bool] = mapped_column(Boolean, default=False)
    check_passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    external: Mapped[bool] = mapped_column(Boolean, default=False)
    chars: Mapped[int | None] = mapped_column(nullable=True)
    # ok=正常跑完 / aborted=客户端提前断开 / error=节点或流水线异常
    status: Mapped[str] = mapped_column(String(16), default="ok")
    error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(nullable=True)
    node_count: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), index=True
    )


class AgentStep(Base):
    __tablename__ = "agent_steps"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(SmallInteger)
    node: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="ok")
    duration_ms: Mapped[int] = mapped_column(default=0)
    # 截断摘要：message/query 留前 160 字，context/answer 只留长度，citations 只留条数
    input: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
