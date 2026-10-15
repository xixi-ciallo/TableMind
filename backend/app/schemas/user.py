import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 中国大陆手机号：1 开头，第二位 3-9，共 11 位
PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=50)
    phone: str = Field(description="中国大陆手机号，唯一")
    password: str = Field(min_length=6, max_length=128)

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        v = v.strip().replace(" ", "").replace("-", "")
        if v.startswith("+86"):
            v = v[3:]
        if not PHONE_RE.match(v):
            raise ValueError("手机号格式不正确，请输入 11 位中国大陆手机号")
        return v


class UserLogin(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    phone: str
    role: str
    avatar: str | None = None
    bio: str | None = None
    is_active: bool
    created_at: datetime


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class AuthResponse(Token):
    """注册 / 登录返回：令牌 + 当前用户，前端可直接写入登录态"""

    user: UserOut
