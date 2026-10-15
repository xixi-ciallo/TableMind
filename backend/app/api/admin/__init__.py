from fastapi import APIRouter, Depends

from app.api.deps import require_admin
from app.api.admin import games, moderation, rule_books, rule_docs, stats, tags, users

router = APIRouter(dependencies=[Depends(require_admin)])

router.include_router(stats.router, prefix="/stats", tags=["admin-stats"])
router.include_router(games.router, prefix="/games", tags=["admin-games"])
router.include_router(tags.router, prefix="/tags", tags=["admin-tags"])
router.include_router(users.router, prefix="/users", tags=["admin-users"])
router.include_router(
    moderation.router, prefix="/moderation", tags=["admin-moderation"]
)
router.include_router(rule_docs.router, tags=["admin-rule-docs"])
# 规则书（原始文件）单独一路由：/rule-books 与 /games/{id}/rule-books
router.include_router(rule_books.router, tags=["admin-rule-books"])
