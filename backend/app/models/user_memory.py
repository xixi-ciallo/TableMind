"""用户记忆层（个性化）的 ORM 模型。

与 RAG 语义记忆（rule_documents，存「事实/规则」）分开存、分开取：
- UserProfile：每用户一行，蒸馏后的结构化偏好快照（情景/语义的混合）。
- UserMemoryEpisode：按时间追加的具体交互事件（情景记忆），如「用户觉得卡坦岛太重」。

容量/冲突策略在 app/agent/memory.py 里实现：画像列表字段合并去重并封顶，
情景事件追加写、超过上限删最旧。
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UserProfile(Base):
    """每用户一行的偏好快照（长期-情景/语义混合记忆）。"""

    __tablename__ = "user_profiles"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), primary_key=True
    )
    # 喜欢的中文分类（如 策略/合作/家庭），合并去重后最多保留 8 个
    preferred_categories: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # 喜欢的中文机制（如 卡牌驱动/区域控制），最多保留 8 个
    preferred_mechanics: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # 明确不喜欢/吐槽过的游戏名（名称即可，不需要 id），最多保留 20 个
    disliked_games: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # 用户表达过的复杂度上限（1-5）；本站 complexity 字段缺失时为软提示
    max_complexity: Mapped[float | None] = mapped_column(nullable=True)
    # 用户常用人数
    preferred_player_count: Mapped[int | None] = mapped_column(nullable=True)
    # 自由备注（按时间追加，便于审计偏好的变化）
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class UserMemoryEpisode(Base):
    """按时间追加的具体交互事件（长期-情景记忆）。"""

    __tablename__ = "user_memory_episodes"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    # preference（偏好表达）/ feedback（反馈吐槽）/ fact（已确认事实）
    kind: Mapped[str] = mapped_column(String(16), nullable=False, server_default="feedback")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # 关联到的游戏名（可选，便于回溯「哪款游戏」）
    game_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
