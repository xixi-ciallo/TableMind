from pydantic import BaseModel


class ChatRequest(BaseModel):
    session_id: int | None = None
    game_id: int | None = None  # 规则问答时限定某款游戏
    message: str
    """回答模式：fast=简要速览，deep=展开更多真实字段；非法值按 fast 处理"""
    mode: str | None = None


class ChatMessageOut(BaseModel):
    role: str
    content: str
