"""规则书（原始文件）与规则文档（切片文本）在数据层分开。

- **规则书 `rule_books`**：管理员上传或抓取到的原始说明书（PDF / 逐页图片），
  保留排版与插图，供前台原样翻阅；一条记录对应一份完整说明书。
- **规则文档 `rule_documents`**：从规则书抽出的纯文本切片 + 向量，只服务于 RAG 检索。

两者用 `rule_book_id` 关联：删规则书会级联删掉它的切片，反之不会误删原文件。
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RuleBook(Base):
    """规则说明书原始文件。"""

    __tablename__ = "rule_books"

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(
        ForeignKey("board_games.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    """规则书标题，如「工业革命：伯明翰 官方规则书（英文）」"""

    file_type: Mapped[str] = mapped_column(String(16))
    """pdf | images（逐页图片包）"""

    file_path: Mapped[str] = mapped_column(String(500))
    """相对 uploads 目录的路径，如 rulebooks/11/brass-birmingham.pdf"""

    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    """页数：PDF 取实际页数，图片包取图片张数"""

    language: Mapped[str] = mapped_column(String(16), default="zh")
    """zh / en / 其他，原文件语言"""

    is_official: Mapped[bool] = mapped_column(Boolean, default=True)
    """是否出版社官方发布；玩家自制翻译为 False"""

    source: Mapped[str | None] = mapped_column(String(200), nullable=True)
    """来源说明：出版社官网 / 管理员上传 / 站内扫描页 OCR 等"""

    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    """原始下载链接，便于回溯与复查"""

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )
