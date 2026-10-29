"""管理员端 P3 评测中心：评测用例 CRUD、触发批量评测、查看批次与 badcase。

批量评测在 BackgroundTasks 里跑（run_eval），接口立即返回 run_id；
前端轮询 GET /admin/evals/runs/{id} 看 completed_count 与结果。
"""
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import eval_runner
from app.api.deps import get_db
from app.models.board_game import BoardGame
from app.models.rag_eval import EvalCase, EvalResult, EvalRun
from app.schemas.eval import (
    EvalCaseIn,
    EvalCaseOut,
    EvalCaseUpdate,
    EvalRunDetail,
    EvalRunIn,
    EvalRunOut,
    EvalResultOut,
)

router = APIRouter()
log = logging.getLogger(__name__)


async def _game_name(db: AsyncSession, game_id: int | None) -> str | None:
    if not game_id:
        return None
    return (await db.execute(select(BoardGame.name).where(BoardGame.id == game_id))).scalar_one_or_none()


def _case_out(case: EvalCase, game_name: str | None = None) -> EvalCaseOut:
    return EvalCaseOut(
        id=case.id,
        game_id=case.game_id,
        game_name=game_name,
        question=case.question,
        reference_answer=case.reference_answer,
        reference_chunks=case.reference_chunks,
        tags=case.tags,
        enabled=case.enabled,
        created_at=case.created_at,
    )


@router.get("/evals/cases", response_model=list[EvalCaseOut])
async def list_cases(
    game_id: int | None = None,
    only_enabled: bool = False,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(EvalCase, BoardGame.name).outerjoin(
        BoardGame, BoardGame.id == EvalCase.game_id
    )
    if game_id:
        stmt = stmt.where(EvalCase.game_id == game_id)
    if only_enabled:
        stmt = stmt.where(EvalCase.enabled.is_(True))
    rows = (await db.execute(stmt.order_by(EvalCase.id.desc()))).all()
    return [_case_out(case, name) for case, name in rows]


@router.post("/evals/cases", response_model=EvalCaseOut, status_code=201)
async def create_case(payload: EvalCaseIn, db: AsyncSession = Depends(get_db)):
    if payload.game_id is not None:
        exists = (
            await db.execute(select(BoardGame.id).where(BoardGame.id == payload.game_id))
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="指定的桌游不存在")
    case = EvalCase(**payload.model_dump())
    db.add(case)
    await db.commit()
    await db.refresh(case)
    return _case_out(case, await _game_name(db, case.game_id))


@router.put("/evals/cases/{case_id}", response_model=EvalCaseOut)
async def update_case(
    case_id: int, payload: EvalCaseUpdate, db: AsyncSession = Depends(get_db)
):
    case = await db.get(EvalCase, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="评测用例不存在")
    data = payload.model_dump(exclude_unset=True)
    if data.get("game_id") is not None:
        exists = (
            await db.execute(select(BoardGame.id).where(BoardGame.id == data["game_id"]))
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(status_code=404, detail="指定的桌游不存在")
    for key, value in data.items():
        setattr(case, key, value)
    await db.commit()
    await db.refresh(case)
    return _case_out(case, await _game_name(db, case.game_id))


@router.delete("/evals/cases/{case_id}")
async def delete_case(case_id: int, db: AsyncSession = Depends(get_db)):
    case = await db.get(EvalCase, case_id)
    if case is None:
        raise HTTPException(status_code=404, detail="评测用例不存在")
    await db.delete(case)
    await db.commit()
    return {"detail": "已删除"}


@router.post("/evals/runs", response_model=EvalRunOut, status_code=202)
async def create_run(
    payload: EvalRunIn,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """创建一个评测批次并后台执行。题库为空时直接拒绝（避免空跑一条无用记录）。"""
    stmt = select(EvalCase.id).where(EvalCase.enabled.is_(True))
    if payload.case_ids:
        stmt = stmt.where(EvalCase.id.in_(payload.case_ids))
    if payload.game_id:
        stmt = stmt.where(EvalCase.game_id == payload.game_id)
    ids = (await db.execute(stmt)).scalars().all()
    if not ids:
        raise HTTPException(
            status_code=400, detail="没有可运行的评测用例，请先添加并启用用例"
        )

    cfg = eval_runner.config_snapshot(payload.case_ids, payload.game_id)
    run = EvalRun(
        status="pending",
        case_count=len(ids),
        completed_count=0,
        config=cfg,
        note=payload.note,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    background.add_task(eval_runner.run_eval, run.id)
    return EvalRunOut.model_validate(run)


@router.get("/evals/runs", response_model=list[EvalRunOut])
async def list_runs(limit: int = 20, db: AsyncSession = Depends(get_db)):
    limit = max(1, min(limit, 100))
    runs = (
        await db.execute(select(EvalRun).order_by(EvalRun.id.desc()).limit(limit))
    ).scalars().all()
    return [EvalRunOut.model_validate(r) for r in runs]


@router.get("/evals/runs/latest", response_model=EvalRunOut | None)
async def latest_run(db: AsyncSession = Depends(get_db)):
    run = (
        await db.execute(
            select(EvalRun)
            .where(EvalRun.status == "completed")
            .order_by(EvalRun.id.desc())
            .limit(1)
        )
    ).scalars().first()
    return EvalRunOut.model_validate(run) if run else None


@router.get("/evals/runs/{run_id}", response_model=EvalRunDetail)
async def run_detail(run_id: int, db: AsyncSession = Depends(get_db)):
    run = await db.get(EvalRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="评测批次不存在")
    results = (
        await db.execute(
            select(EvalResult)
            .where(EvalResult.run_id == run_id)
            .order_by(EvalResult.overall.asc().nullsfirst(), EvalResult.id)
        )
    ).scalars().all()
    return EvalRunDetail(
        **EvalRunOut.model_validate(run).model_dump(),
        results=[EvalResultOut.model_validate(r) for r in results],
    )


@router.delete("/evals/runs/{run_id}")
async def delete_run(run_id: int, db: AsyncSession = Depends(get_db)):
    run = await db.get(EvalRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="评测批次不存在")
    await db.execute(delete(EvalResult).where(EvalResult.run_id == run_id))
    await db.delete(run)
    await db.commit()
    return {"detail": "已删除"}
