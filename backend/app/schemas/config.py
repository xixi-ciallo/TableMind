"""P4 管理端系统配置接口的请求/响应模型。"""
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ConfigUpdateIn(BaseModel):
    """value 用 Any：具体类型由后端注册表按 key 校验，避免为 20 个键各写一个入参模型。"""

    value: Any


class ConfigItemOut(BaseModel):
    key: str
    group: str
    label: str
    description: str
    kind: str
    # 当前生效值（已按注册表类型转换），前端据此选择开关/下拉/数字框
    value: Any
    default: Any
    # db=被管理端覆盖；env=读取 .env
    source: str
    options: list[str] = []
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    updated_at: datetime | None = None
    updated_by_name: str | None = None


class ConfigAuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    key: str
    action: str
    old_value: str | None = None
    new_value: str | None = None
    operator_id: int | None = None
    operator_name: str | None = None
    created_at: datetime
