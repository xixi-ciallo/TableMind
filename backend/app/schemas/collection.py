from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class CollectionCreate(BaseModel):
    game_id: int
    status: str = Field(pattern="^(want|played|owned)$")


class CollectionUpdate(BaseModel):
    status: str = Field(pattern="^(want|played|owned)$")


class CollectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    game_id: int
    status: str
    created_at: datetime
    # 列表展示用：关联桌游的名称与封面（游戏已下架时为 None）
    game_name: str | None = None
    cover_image: str | None = None
