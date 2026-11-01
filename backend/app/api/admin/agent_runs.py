"""管理员端：Agentic RAG 运行轨迹查询（agent_run / agent_step）。

GET /api/admin/agent-runs            最近运行列表
GET /api/admin/agent-runs/{run_id}   单次运行 + 节点明细（按 seq 逐节点回放）
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.agent_trace import AgentRun, AgentStep

router = APIRouter()


class AgentStepOut(BaseModel):
    seq: int
    node: str
    status: str
    duration_ms: int
    input: dict | None
    output: dict | None


class AgentRunOut(BaseModel):
    id: int
    message: str
    level: int | None
    fallback: bool
    check_passed: bool | None
    external: bool
    chars: int | None
    status: str
    error: str | None
    duration_ms: int | None
    node_count: int | None
    created_at: datetime


class AgentRunDetail(AgentRunOut):
    steps: list[AgentStepOut]


def _run_out(run: AgentRun) -> AgentRunOut:
    return AgentRunOut(
        id=run.id,
        message=run.message,
        level=run.level,
        fallback=run.fallback,
        check_passed=run.check_passed,
        external=run.external,
        chars=run.chars,
        status=run.status,
        error=run.error,
        duration_ms=run.duration_ms,
        node_count=run.node_count,
        created_at=run.created_at,
    )


@router.get("/agent-runs", response_model=list[AgentRunOut])
async def list_agent_runs(limit: int = 50, db: AsyncSession = Depends(get_db)):
    """最近运行列表，新的在前。"""
    rows = await db.execute(
        select(AgentRun).order_by(AgentRun.id.desc()).limit(min(max(limit, 1), 200))
    )
    return [_run_out(run) for run in rows.scalars().all()]


@router.get("/agent-runs/{run_id}", response_model=AgentRunDetail)
async def get_agent_run(run_id: int, db: AsyncSession = Depends(get_db)):
    """单次运行与其节点明细，按 seq 排序即执行顺序（逐节点回放）。"""
    run = (
        await db.execute(select(AgentRun).where(AgentRun.id == run_id))
    ).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="运行记录不存在")
    steps = (
        (
            await db.execute(
                select(AgentStep)
                .where(AgentStep.run_id == run_id)
                .order_by(AgentStep.seq)
            )
        )
        .scalars()
        .all()
    )
    return AgentRunDetail(
        **_run_out(run).model_dump(),
        steps=[
            AgentStepOut(
                seq=s.seq,
                node=s.node,
                status=s.status,
                duration_ms=s.duration_ms,
                input=s.input,
                output=s.output,
            )
            for s in steps
        ],
    )
