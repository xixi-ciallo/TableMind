"""搜索：记录玩家真实搜索 + 聚合热门搜索。

- POST /search/log  记录一次搜索（匿名也可，user_id 可选）
- GET  /search/hot  返回按真实搜索次数降序的热门词（与社区右侧「热门搜索」同源）
"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_optional_user, get_db
from app.models.search_log import SearchLog
from app.models.user import User

router = APIRouter()


class SearchLogIn(BaseModel):
    kind: str  # 'game' | 'post'
    term: str


@router.post("/log", status_code=204)
async def log_search(
    data: SearchLogIn,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_user),
):
    term = (data.term or "").strip().lower()
    kind = data.kind if data.kind in ("game", "post") else "game"
    # 空词 / 过短不记录，避免噪声
    if len(term) < 1 or len(term) > 120:
        return
    db.add(
        SearchLog(
            user_id=current_user.id if current_user else None,
            kind=kind,
            term=term,
        )
    )
    await db.commit()


@router.get("/hot", response_model=list[dict])
async def hot_searches(
    limit: int = Query(8, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
):
    """热门搜索：按真实搜索次数降序，返回 [{term, count}]。"""
    rows = (
        await db.execute(
            select(SearchLog.term, func.count(SearchLog.id).label("cnt"))
            .group_by(SearchLog.term)
            .order_by(func.count(SearchLog.id).desc(), SearchLog.term.asc())
            .limit(limit)
        )
    ).all()
    return [{"term": term, "count": int(cnt)} for term, cnt in rows]
