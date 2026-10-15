from fastapi import APIRouter

from app.api.user import (
    ai, auth, collections, comments, games, me, posts, rankings, reviews, search,
)

router = APIRouter()

router.include_router(auth.router, prefix="/auth", tags=["auth"])
router.include_router(games.router, prefix="/games", tags=["games"])
router.include_router(rankings.router, prefix="/rankings", tags=["rankings"])
router.include_router(reviews.router, prefix="/reviews", tags=["reviews"])
router.include_router(posts.router, prefix="/posts", tags=["posts"])
router.include_router(comments.router, prefix="/comments", tags=["comments"])
router.include_router(collections.router, prefix="/collections", tags=["collections"])
router.include_router(search.router, prefix="/search", tags=["search"])
router.include_router(ai.router, prefix="/ai", tags=["ai"])
router.include_router(me.router, prefix="/me", tags=["me"])
