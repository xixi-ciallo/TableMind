from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ReviewCreate(BaseModel):
    game_id: int
    rating: int = Field(ge=1, le=10)
    # 正文可选：允许「只打分不写内容」的纯评分（右侧快捷评分入口）。
    # 有正文的才算「评测」；纯评分只计入评分汇总，不进入评测列表 / 内容审核。
    content: str | None = Field(None, max_length=2000)
    images: list[str] | None = None


class ReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    game_id: int
    rating: int
    content: str | None = None
    like_count: int
    created_at: datetime
    username: str | None = None
    game_name: str | None = None
    images: list[str] | None = None
    comment_count: int = 0
    liked: bool = False


class ReviewCommentOut(BaseModel):
    id: int
    review_id: int
    user_id: int
    content: str
    created_at: datetime
    username: str | None = None


class ReviewCommentCreate(BaseModel):
    content: str = Field(min_length=1, max_length=500)


class ReviewLikeResult(BaseModel):
    review_id: int
    like_count: int
    liked: bool


class ReviewImageResult(BaseModel):
    review_id: int
    images: list[str]


class RatingSummary(BaseModel):
    """某款桌游在本站的评分汇总，全部来自真实评测聚合，无数据时为 0。"""

    game_id: int
    avg_rating: float
    rating_count: int
    my_rating: int | None = None
