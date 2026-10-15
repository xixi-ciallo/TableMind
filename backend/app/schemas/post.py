from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PollOptionOut(BaseModel):
    id: int
    label: str
    vote_count: int = 0


class PollOut(BaseModel):
    """帖子投票（详情接口返回；my_options 为当前用户已投选项）。"""

    id: int
    question: str
    multi: bool
    end_at: datetime
    options: list[PollOptionOut] = []
    total_voters: int = 0
    my_options: list[int] = []
    expired: bool = False


class PollCreate(BaseModel):
    """随发帖创建投票：选项 2-10 个，每个 ≤18 字；时长单位为天。"""

    question: str = Field(min_length=1, max_length=16)
    options: list[str] = Field(min_length=2, max_length=10)
    multi: bool = False
    duration_days: int = Field(default=7, ge=1, le=365)

    @field_validator("options")
    @classmethod
    def _check_options(cls, v: list[str]) -> list[str]:
        cleaned = [o.strip() for o in v if o.strip()]
        if len(cleaned) < 2:
            raise ValueError("至少需要 2 个非空选项")
        if any(len(o) > 18 for o in cleaned):
            raise ValueError("选项长度不能超过 18 字")
        return cleaned


class PostCreate(BaseModel):
    game_id: int | None = None
    title: str = Field(max_length=200)
    content: str
    """发布前已上传、待绑定到本帖的正文内嵌附件 id（按传入顺序排序）"""
    media_ids: list[int] = []
    """头图区附件 id（最多 18 张图或 1 个视频，互斥；第一张图为封面）"""
    header_media_ids: list[int] = []
    """随帖创建的投票（可选，一块帖子最多一个投票）"""
    poll: PollCreate | None = None


class PollVoteIn(BaseModel):
    """单选传 1 个 option_id；多选传完整选项集合（全量替换）。"""

    option_ids: list[int] = Field(min_length=1, max_length=10)


class PostUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    content: str | None = None


class PostMediaOut(BaseModel):
    """帖子附件（图片 / 视频）。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    slot: str = "inline"
    url: str
    sort_order: int = 0


class PostOut(BaseModel):
    """帖子卡片 / 详情。统计值均来自真实表聚合，不做估算。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    game_id: int | None = None
    title: str
    content: str
    created_at: datetime
    is_pinned: bool = False
    # 浏览量（真实计数）
    view_count: int = 0
    # 关联桌游封面（列表缩略图，来自 board_games.cover_image）
    game_cover: str | None = None
    # 作者信息
    author_name: str = ""
    author_role: str = "user"
    author_avatar: str | None = None
    """作者是管理员 → 视为官方发布"""
    is_official: bool = False
    # 关联桌游（可能为 None）
    game_name: str | None = None
    # 关联桌游扩展信息（详情页「相关桌游」卡片用，真实字段）
    game_name_en: str | None = None
    game_year: int | None = None
    game_category: str | None = None
    # 真实聚合统计
    like_count: int = 0
    comment_count: int = 0
    liked: bool = False
    # 帖子收藏（真实计数）
    marked: bool = False
    mark_count: int = 0
    # 帖子自带图片 / 视频（真实附件记录）
    media: list[PostMediaOut] = []
    # 头图区（≤18 张图或 1 个视频，互斥；第一张图即封面）
    header_media: list[PostMediaOut] = []
    header_video: PostMediaOut | None = None
    # 帖子投票（详情接口返回，列表为 None）
    poll: PollOut | None = None
    """列表缩略图：帖内首张图片（没有图片则为 None，前端不放占位图）"""
    cover_image: str | None = None
    """无图片但有视频时的封面视频地址"""
    cover_video: str | None = None


class CommentCreate(BaseModel):
    parent_id: int | None = None
    content: str = Field(min_length=1, max_length=2000)


class CommentLikeToggle(BaseModel):
    """评论赞/踩：1=赞，-1=踩。"""

    value: int = Field(ge=-1, le=1)


class CommentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    post_id: int
    user_id: int
    parent_id: int | None = None
    content: str
    created_at: datetime
    author_name: str = ""
    author_role: str = "user"
    author_avatar: str | None = None
    # 评论赞/踩（真实计数；liked/disliked 为当前用户视角）
    like_count: int = 0
    dislike_count: int = 0
    liked: bool = False
    disliked: bool = False


class PostStats(BaseModel):
    """社区侧栏数据：热门话题（按帖子浏览量排序，展示帖子标题）与热门搜索（真实搜索记录）。"""

    topics: list[dict] = []
    hot_searches: list[dict] = []


class PostMarkOut(BaseModel):
    """我的帖子收藏（个人中心）：真实计数与收藏时间。"""

    post_id: int
    marked_at: datetime
    title: str
    author_name: str = ""
    cover_image: str | None = None
    like_count: int = 0
    comment_count: int = 0
    view_count: int = 0
