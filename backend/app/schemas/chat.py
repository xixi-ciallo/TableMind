from pydantic import BaseModel


class ChatRequest(BaseModel):
    session_id: int | None = None
    game_id: int | None = None  # 规则问答时限定某款游戏
    message: str


class ChatMessageOut(BaseModel):
    role: str
    content: str
