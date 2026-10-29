"""P3 批量评测执行器：检索 → 生成 → 四维裁判 → 落库。

设计要点：
- **复用线上链路**：检索直接调 rule_qa.retrieve_layered_with_citations，生成复用
  build_generation_messages，保证评测跑的就是用户实际会遇到的链路，而不是另写一套。
- **单条失败不拖垮整批**：每条用例的异常写入该条 error，其余用例继续；批次最终
  只要跑完就标记 completed，并记录失败条数。
- **可轮询进度**：每完成一条就更新 completed_count，管理端边跑边看。
- **配置快照**：把融合方式、分词、重排、父子回填、生成/裁判模型写进 run.config，
  这样两个批次分数不同时能解释「为什么不同」。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime

from sqlalchemy import func, select, update

from app.agent import eval_judge, llm
from app.agent import rule_qa
from app.core.config import settings
from app.core.database import async_session_factory
from app.models.rag_eval import EvalCase, EvalResult, EvalRun

log = logging.getLogger(__name__)

_CHUNK_MARK_RE = re.compile(r"\n\n片段\d+：")
_METRICS = ("context_recall", "context_precision", "faithfulness", "answer_relevance")


def split_contexts(context: str) -> list[str]:
    """把拼好的上下文还原成片段列表，交给裁判逐段评估。

    L2 的上下文形如「片段1：…\\n\\n片段2：…」；L1/L3/L4 是整段文本，整体作为
    一个片段（裁判仍能判断相关性）。
    """
    text = (context or "").strip()
    if not text:
        return []
    if "片段1：" in text:
        parts = _CHUNK_MARK_RE.split(text)
        return [p.strip() for p in parts[1:] if p.strip()]
    return [text]


def config_snapshot(case_ids: list[int] | None, game_id: int | None) -> dict:
    """记录本次评测的运行配置，便于解释不同批次的分差。"""
    return {
        "case_ids": case_ids,
        "game_id": game_id,
        "generation_model": settings.LLM_RULE_MODEL or settings.LLM_MODEL,
        "judge_model": settings.EVAL_JUDGE_MODEL or settings.LLM_MODEL,
        "fusion": settings.RAG_FUSION,
        "vector_weight": settings.RAG_VECTOR_WEIGHT,
        "bm25_weight": settings.RAG_BM25_WEIGHT,
        "bm25_tokenizer": settings.RAG_BM25_TOKENIZER,
        "query_expand": settings.RAG_QUERY_EXPAND_ENABLED,
        "hyde": settings.HYDE_ENABLED,
        "rerank_enabled": settings.RERANK_ENABLED,
        "rerank_method": settings.RERANK_METHOD,
        "parent_fill": settings.PARENT_FILL_ENABLED,
        "top_k": rule_qa.TOP_K,
    }


async def evaluate_case(db, case: EvalCase) -> dict:
    """跑一条用例，返回可直接写入 EvalResult 的字段（不含 run_id）。"""
    payload: dict = {
        "case_id": case.id,
        "game_id": case.game_id,
        "question": case.question,
        "reference_answer": case.reference_answer,
        "level": None,
        "answer": None,
        "contexts": None,
        "citations": None,
        "error": None,
        "latency_ms": None,
    }
    t0 = time.perf_counter()
    try:
        level, context, game, citations = await rule_qa.retrieve_layered_with_citations(
            db, case.question, game_id=case.game_id
        )
        payload["level"] = level
        payload["game_id"] = game.id if game else case.game_id
        payload["contexts"] = split_contexts(context)
        payload["citations"] = citations

        msgs = await rule_qa.build_generation_messages(
            db, case.question, None, context, rule_qa.LEVEL_LABEL.get(level, "")
        )
        answer = await llm.chat_complete(
            msgs,
            temperature=0.3,
            max_tokens=settings.EVAL_ANSWER_MAX_TOKENS,
            model=settings.LLM_RULE_MODEL or settings.LLM_MODEL,
            enable_thinking=settings.LLM_RULE_THINKING,
        )
        payload["answer"] = answer

        judged = await eval_judge.judge_case(
            case.question, answer, payload["contexts"] or [], case.reference_answer
        )
        payload.update(
            context_recall=judged.context_recall,
            context_precision=judged.context_precision,
            faithfulness=judged.faithfulness,
            answer_relevance=judged.answer_relevance,
            overall=judged.overall,
            judge_reasons={
                "reasons": judged.reasons,
                "raw": judged.raw[:4000],
                "error": judged.error,
            },
        )
        if judged.error and not judged.raw:
            payload["error"] = judged.error
        elif judged.error:
            payload["error"] = f"部分指标缺失：{judged.error}"
    except Exception as e:  # noqa: BLE001
        log.exception("评测用例失败 case_id=%s", case.id)
        payload["error"] = f"{type(e).__name__}: {e}"
        payload.update(
            context_recall=None,
            context_precision=None,
            faithfulness=None,
            answer_relevance=None,
            overall=None,
            judge_reasons=None,
        )
    payload["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    return payload


def summarize(rows: list[EvalResult]) -> dict:
    """批次汇总：四指标有效均值、通过率、失败条数、检索层级分布。"""
    avg: dict[str, float | None] = {}
    for key in _METRICS + ("overall",):
        vals = [getattr(r, key) for r in rows if getattr(r, key) is not None]
        avg[key] = round(sum(vals) / len(vals), 4) if vals else None

    scored = [r for r in rows if r.overall is not None]
    passed = [r for r in scored if r.overall >= settings.EVAL_PASS_THRESHOLD]
    levels: dict[str, int] = {}
    for r in rows:
        if r.level is not None:
            levels[str(r.level)] = levels.get(str(r.level), 0) + 1
    return {
        "cases": len(rows),
        "scored": len(scored),
        "failed": sum(1 for r in rows if r.error),
        "pass_threshold": settings.EVAL_PASS_THRESHOLD,
        "pass_rate": round(len(passed) / len(scored), 4) if scored else None,
        "avg": avg,
        "levels": levels,
    }


async def _mark_failed(run_id: int, message: str) -> None:
    async with async_session_factory() as db:
        await db.execute(
            update(EvalRun)
            .where(EvalRun.id == run_id)
            .values(
                status="failed",
                error=message[:2000],
                finished_at=datetime.utcnow(),
            )
        )
        await db.commit()


async def run_eval(run_id: int) -> None:
    """后台执行一个评测批次。供 FastAPI BackgroundTasks 调用。"""
    try:
        async with async_session_factory() as db:
            run = await db.get(EvalRun, run_id)
            if run is None:
                return
            cfg = run.config or {}
            case_ids = cfg.get("case_ids") or []
            game_id = cfg.get("game_id")
            await db.execute(
                update(EvalRun)
                .where(EvalRun.id == run_id)
                .values(status="running", started_at=datetime.utcnow())
            )
            await db.commit()

        async with async_session_factory() as db:
            stmt = select(EvalCase).where(EvalCase.enabled.is_(True))
            if case_ids:
                stmt = stmt.where(EvalCase.id.in_(case_ids))
            if game_id:
                stmt = stmt.where(EvalCase.game_id == game_id)
            cases = (await db.execute(stmt.order_by(EvalCase.id))).scalars().all()

        if not cases:
            await _mark_failed(run_id, "没有可运行的评测用例：请先添加用例或勾选启用")
            return

        # 用例可能在创建批次后增删，这里以实际读到的数量为准
        async with async_session_factory() as db:
            await db.execute(
                update(EvalRun)
                .where(EvalRun.id == run_id)
                .values(case_count=len(cases))
            )
            await db.commit()

        sem = asyncio.Semaphore(max(1, settings.EVAL_CONCURRENCY))
        write_lock = asyncio.Lock()

        async def worker(case: EvalCase) -> None:
            async with sem:
                async with async_session_factory() as db:
                    row = await evaluate_case(db, case)
                async with write_lock:
                    async with async_session_factory() as wdb:
                        wdb.add(EvalResult(run_id=run_id, **row))
                        await wdb.execute(
                            update(EvalRun)
                            .where(EvalRun.id == run_id)
                            .values(completed_count=EvalRun.completed_count + 1)
                        )
                        await wdb.commit()

        await asyncio.gather(*(worker(c) for c in cases), return_exceptions=True)

        async with async_session_factory() as db:
            rows = (
                await db.execute(
                    select(EvalResult).where(EvalResult.run_id == run_id)
                )
            ).scalars().all()
            await db.execute(
                update(EvalRun)
                .where(EvalRun.id == run_id)
                .values(
                    status="completed",
                    summary=summarize(list(rows)),
                    completed_count=len(rows),
                    finished_at=datetime.utcnow(),
                )
            )
            await db.commit()
    except Exception as e:  # noqa: BLE001
        log.exception("评测批次失败 run_id=%s", run_id)
        await _mark_failed(run_id, f"{type(e).__name__}: {e}")


async def latest_run_summary(db) -> dict | None:
    """最近一次完成的批次汇总（供仪表盘/接口展示）。"""
    run = (
        await db.execute(
            select(EvalRun)
            .where(EvalRun.status == "completed")
            .order_by(EvalRun.id.desc())
            .limit(1)
        )
    ).scalars().first()
    if run is None:
        return None
    return {"run_id": run.id, "summary": run.summary, "finished_at": run.finished_at}


if __name__ == "__main__":
    # 不依赖 DB/LLM：验证上下文拆分与汇总计算。
    ctx = "《某某》的规则说明书原文片段（共 2 段）：\n\n片段1：每人拿 7 元。\n\n片段2：回合结束抽卡。"
    assert split_contexts(ctx) == ["每人拿 7 元。", "回合结束抽卡。"]
    assert split_contexts("整段结构化资料") == ["整段结构化资料"]
    assert split_contexts("") == []

    class _R:
        def __init__(self, **kw):
            self.context_recall = kw.get("cr")
            self.context_precision = kw.get("cp")
            self.faithfulness = kw.get("fa")
            self.answer_relevance = kw.get("ar")
            self.overall = kw.get("ov")
            self.level = kw.get("lv")
            self.error = kw.get("err")

    rows = [
        _R(cr=1.0, cp=0.8, fa=1.0, ar=0.8, ov=0.9, lv=2),
        _R(cr=None, cp=0.6, fa=0.4, ar=0.6, ov=0.5333, lv=2),
        _R(err="boom", lv=4),
    ]
    s = summarize(rows)
    assert s["cases"] == 3 and s["scored"] == 2 and s["failed"] == 1
    assert s["avg"]["context_recall"] == 1.0
    assert s["levels"] == {"2": 2, "4": 1}
    assert s["pass_rate"] == 0.5
    print("eval runner self-test OK", s)
