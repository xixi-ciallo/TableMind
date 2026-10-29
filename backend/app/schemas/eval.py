"""P3 管理端评测接口的请求/响应模型。"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class EvalCaseIn(BaseModel):
    game_id: int | None = None
    question: str = Field(min_length=2, max_length=500)
    reference_answer: str | None = Field(default=None, max_length=4000)
    reference_chunks: list[int] | None = None
    tags: str | None = Field(default=None, max_length=120)
    enabled: bool = True


class EvalCaseUpdate(BaseModel):
    game_id: int | None = None
    question: str | None = Field(default=None, min_length=2, max_length=500)
    reference_answer: str | None = Field(default=None, max_length=4000)
    reference_chunks: list[int] | None = None
    tags: str | None = Field(default=None, max_length=120)
    enabled: bool | None = None


class EvalCaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    game_id: int | None = None
    game_name: str | None = None
    question: str
    reference_answer: str | None = None
    reference_chunks: list[int] | None = None
    tags: str | None = None
    enabled: bool
    created_at: datetime


class EvalRunIn(BaseModel):
    case_ids: list[int] | None = None
    game_id: int | None = None
    note: str | None = Field(default=None, max_length=200)


class EvalResultOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    case_id: int | None = None
    game_id: int | None = None
    question: str
    reference_answer: str | None = None
    level: int | None = None
    answer: str | None = None
    contexts: list[str] | None = None
    citations: list[dict] | None = None
    context_recall: float | None = None
    context_precision: float | None = None
    faithfulness: float | None = None
    answer_relevance: float | None = None
    overall: float | None = None
    judge_reasons: dict | None = None
    error: str | None = None
    latency_ms: int | None = None


class EvalRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    case_count: int
    completed_count: int
    config: dict | None = None
    summary: dict | None = None
    error: str | None = None
    note: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class EvalRunDetail(EvalRunOut):
    results: list[EvalResultOut] = []
