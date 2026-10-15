from pydantic import BaseModel

from app.schemas.game import GameOut
from app.schemas.user import UserOut


class DailyPoint(BaseModel):
    date: str
    users: int = 0
    reviews: int = 0
    posts: int = 0
    ai_calls: int = 0


class SeriesPoint(BaseModel):
    date: str
    values: dict = {}


class GamePoint(BaseModel):
    id: int
    name: str
    cover_image: str | None = None
    avg_rating: float = 0
    rating_count: int = 0


class RatingPoint(BaseModel):
    rating: int
    count: int


class TagPoint(BaseModel):
    name: str
    type: str
    usage_count: int


class RuleDocStatus(BaseModel):
    game_id: int
    chunk_count: int = 0
    vectorized: bool = False


class RuleDocSummary(BaseModel):
    """规则文档总览：按桌游聚合，供管理端首屏直接看到库里已有哪些说明书。"""

    game_id: int
    game_name: str | None = None
    chunk_count: int = 0
    vectorized: bool = False


class RuleChunkItem(BaseModel):
    """规则切片预览：让管理员能看到说明书实际被切成了什么内容。"""

    chunk_index: int
    content: str
    char_count: int
    has_embedding: bool


class RuleChunkUpdate(BaseModel):
    """修正单条切片正文（OCR 错字、漏段落等）。"""

    content: str


class RuleBookOut(BaseModel):
    """规则书（原始说明书文件），与规则文档切片分开返回。

    `url` 是可直接访问的文件地址；`pages` 仅在图片型规则书下返回（供逐页翻阅）。
    """

    id: int
    game_id: int
    game_name: str | None = None
    title: str
    file_type: str
    """pdf | images"""

    file_path: str
    url: str
    page_count: int | None = None
    language: str = "zh"
    is_official: bool = True
    source: str | None = None
    source_url: str | None = None
    chunk_count: int = 0
    """由该规则书生成的规则文档切片数"""

    vectorized: bool = False
    pages: list[str] | None = None
    """图片型规则书的页文件名（按顺序）"""

    created_at: str | None = None


class RuleBookUpdate(BaseModel):
    """修改规则书元信息（不改文件本身）。"""

    title: str | None = None
    language: str | None = None
    is_official: bool | None = None
    source: str | None = None
    source_url: str | None = None


class RuleDocUploadResult(BaseModel):
    """上传结果：区分「本次新增」与「该桌游切片总数」，追加模式下两者不同。"""

    game_id: int
    chunk_count: int = 0
    """该桌游当前切片总数"""

    added: int = 0
    """本次上传新增的切片数"""

    vectorized: bool = False
    mode: str = "replace"
    source: str = ""
    """解析来源：pdf / text / image-ocr"""


class StatsOut(BaseModel):
    """仪表盘统计。

    计数类字段为数据库真实行数；序列类字段在「还没有数据」时返回空数组，
    前端据此展示空态，不补任何假数据。
    """

    user_count: int = 0
    game_count: int = 0
    review_count: int = 0
    post_count: int = 0
    ai_call_count: int = 0

    # ── 图表数据 ──
    days: int = 0
    """日轴天数"""

    series: list[SeriesPoint] = []
    """[{date, values:{users,reviews,posts,ai_calls}}]"""

    top_games: list[GamePoint] = []
    """[{id,name,cover_image,avg_rating,rating_count}]"""

    rating_distribution: list[RatingPoint] = []
    """[{rating,count}] 1~10 分各档评测数量"""

    tag_usage: list[TagPoint] = []
    """[{name,type,usage_count}] 标签使用量 Top"""


class AdminGameOut(GameOut):
    """管理端桌游输出：在公开字段之外带回 admin_note 与规则文档情况。"""

    admin_note: str | None = None
    rule_chunk_count: int = 0
    """该桌游已入库的规则说明书切片数，0 表示尚无说明书"""


class GameListOut(BaseModel):
    """带总数与完整度评分的桌游分页结果，供管理端分页与数据体检使用。"""

    total: int
    items: list[AdminGameOut]
    incomplete: int = 0
    """资料不完整的桌游数量（缺简介、封面、人数或时长之一）"""


class GameCompleteness(BaseModel):
    """单款桌游的资料完整度体检结果。"""

    id: int
    name: str
    score: int
    """0~100，按关键字段是否齐全加权计算"""
    missing: list[str] = []
    """缺失字段的中文说明"""


class UserListOut(BaseModel):
    """用户分页结果：带真实总数，另附被禁用账号数。"""

    total: int
    items: list[UserOut]
    disabled: int = 0


class AdminUserDetail(UserOut):
    """用户详情：在公开字段之外带回该用户在站内的真实产出条数。"""

    review_count: int = 0
    post_count: int = 0
    collection_count: int = 0
