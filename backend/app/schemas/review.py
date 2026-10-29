from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ReviewCreate(BaseModel):
    """评分与评测共用同一张表，但两个入口各写各的字段：

    - 「玩家评分」只传 rating；
    - 「玩家评测」只传 content（可带图片）；
    - 两者至少提供一项，避免写出一条空记录。
    """

    game_id: int
    rating: int | None = Field(None, ge=1, le=10)
    content: str | None = Field(None, max_length=2000)
    images: list[str] | None = None

    @model_validator(mode="after")
    def _at_least_one(self):
        if self.rating is None and not (self.content and self.content.strip()):
            raise ValueError("评分与评测内容至少提供一项")
        return self


class ReviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    game_id: int
    rating: int | None = None
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
