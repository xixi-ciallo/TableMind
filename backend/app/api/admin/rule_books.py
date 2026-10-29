"""管理员端规则书管理：规则书（原始文件）与规则文档（切片）分开管。

职责边界：
- 本模块管「规则书」——一份完整说明书的 PDF 或逐页图片，落盘 + 登记元信息，
  并**派生**出规则文档切片（交给 rule_docs 的分块/向量逻辑）。
- `rule_docs.py` 管「规则文档」——切片文本的查看、改字、删除、补向量。

删除规则书会级联删掉它派生的切片（外键 ondelete=CASCADE），不留孤儿数据。
"""
import os
import re
import shutil
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.board_game import BoardGame
from app.models.rule_book import RuleBook
from app.models.rule_document import RuleDocument
from app.schemas.admin import RuleBookOut, RuleBookUpdate

router = APIRouter()

# 本文件位于 <root>/backend/app/api/admin/rule_books.py
# dirname: 1=admin 2=api 3=app 4=backend 5=<root>
_HERE = os.path.abspath(__file__)
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_HERE))))
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)

# uploads/rulebooks/<game_id>/<file> —— 由 main.py 挂载到 /uploads 静态服务
UPLOAD_ROOT = os.path.join(_BACKEND_DIR, "app", "uploads", "rulebooks")
# 站内已收录的官方规则书扫描页（前端 public 目录，URL 前缀 /rules/）
IN_SITE_RULES = os.path.join(_PROJECT_ROOT, "frontend", "public", "rules")

MAX_BYTES = 40 * 1024 * 1024
PDF_EXTS = (".pdf",)
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def _safe_name(name: str) -> str:
    """只保留安全字符，避免路径穿越与奇怪文件名。"""
    base = os.path.basename(name or "rule")
    base = re.sub(r"[^\w.\-]", "_", base, flags=re.UNICODE)
    return base[-120:] or "rule"


def _pages_of_dir(path: str) -> list[str]:
    """图片型规则书：按文件名里的页码排序返回页列表。"""
    if not os.path.isdir(path):
        return []
    files = [f for f in os.listdir(path) if f.lower().endswith(IMAGE_EXTS)]
    return sorted(files, key=lambda f: int("".join(re.findall(r"\d+", f)) or 0) or 0)


def _abs_path(file_path: str) -> str:
    """file_path 为 URL 路径（/uploads/... 或 /rules/...），转成磁盘绝对路径。"""
    rel = file_path.lstrip("/")
    if rel.startswith("uploads/"):
        return os.path.join(os.path.dirname(UPLOAD_ROOT), rel[len("uploads/"):])
    if rel.startswith("rules/"):
        return os.path.join(os.path.dirname(IN_SITE_RULES), rel)
    return os.path.join(UPLOAD_ROOT, rel)


def _url_of(file_path: str) -> str:
    return file_path if file_path.startswith("/") else f"/uploads/{file_path}"


async def _counts(db: AsyncSession, book_id: int) -> tuple[int, int]:
    total = (
        await db.execute(
            select(func.count(RuleDocument.id)).where(RuleDocument.rule_book_id == book_id)
        )
    ).scalar() or 0
    vec = (
        await db.execute(
            select(func.count(RuleDocument.id)).where(
                RuleDocument.rule_book_id == book_id,
                RuleDocument.embedding.isnot(None),
            )
        )
    ).scalar() or 0
    return int(total), int(vec)


async def _to_out(db: AsyncSession, book: RuleBook, with_pages: bool = False) -> RuleBookOut:
    game = await db.get(BoardGame, book.game_id)
    total, vec = await _counts(db, book.id)
    pages = None
    if with_pages and book.file_type == "images":
        pages = _pages_of_dir(_abs_path(book.file_path))
    return RuleBookOut(
        id=book.id,
        game_id=book.game_id,
        game_name=game.name if game else None,
        title=book.title,
        file_type=book.file_type,
        file_path=book.file_path,
        url=_url_of(book.file_path),
        page_count=book.page_count,
        language=book.language,
        is_official=book.is_official,
        source=book.source,
        source_url=book.source_url,
        chunk_count=total,
        vectorized=total > 0 and vec == total,
        pages=pages,
        created_at=book.created_at.isoformat() if isinstance(book.created_at, datetime) else None,
    )


@router.get("/rule-books", response_model=list[RuleBookOut])
async def list_rule_books(db: AsyncSession = Depends(get_db)):
    """规则书总览：管理端可一眼看到全库哪些桌游有说明书原文件。"""
    rows = (
        await db.execute(select(RuleBook).order_by(RuleBook.game_id, RuleBook.id))
    ).scalars().all()
    return [await _to_out(db, b) for b in rows]


@router.get("/games/{game_id}/rule-books", response_model=list[RuleBookOut])
async def list_game_rule_books(game_id: int, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(RuleBook).where(RuleBook.game_id == game_id).order_by(RuleBook.id)
        )
    ).scalars().all()
    return [await _to_out(db, b, with_pages=True) for b in rows]


@router.post("/games/{game_id}/rule-books", response_model=RuleBookOut)
async def upload_rule_book(
    game_id: int,
    file: UploadFile = File(...),
    title: str | None = Form(None),
    language: str = Form("zh"),
    is_official: bool = Form(True),
    source: str | None = Form(None),
    source_url: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
):
    """上传一份规则书（PDF 或图片）。

    只登记文件与元信息，**不自动生成切片**——切片由规则文档区的「从规则书生成」触发，
    便于管理员先确认文件无误再入库，也避免大文件重复解析。
    """
    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, f"文件超过 {MAX_BYTES // 1024 // 1024}MB 上限")

    name = _safe_name(file.filename or "")
    lower = name.lower()
    if lower.endswith(PDF_EXTS):
        file_type = "pdf"
    elif lower.endswith(IMAGE_EXTS):
        file_type = "images"
    else:
        raise HTTPException(400, "只支持 PDF 或图片（jpg/png/webp）")

    dest_dir = os.path.join(UPLOAD_ROOT, str(game_id))
    os.makedirs(dest_dir, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    dest = os.path.join(dest_dir, f"{stamp}_{name}")
    with open(dest, "wb") as fh:
        fh.write(raw)

    page_count: int | None = None
    if file_type == "pdf":
        try:
            from pypdf import PdfReader

            page_count = len(PdfReader(dest).pages)
        except Exception:  # noqa: BLE001 - 页数取不到就留空，不编造
            page_count = None

    rel = f"/uploads/rulebooks/{game_id}/{os.path.basename(dest)}"
    book = RuleBook(
        game_id=game_id,
        title=(title or "").strip() or f"{game.name} 规则书",
        file_type=file_type,
        file_path=rel,
        page_count=page_count,
        language=language or "zh",
        is_official=bool(is_official),
        source=source,
        source_url=source_url,
    )
    db.add(book)
    await db.commit()
    await db.refresh(book)
    return await _to_out(db, book, with_pages=True)


@router.patch("/rule-books/{book_id}", response_model=RuleBookOut)
async def update_rule_book(
    book_id: int, body: RuleBookUpdate, db: AsyncSession = Depends(get_db)
):
    book = await db.get(RuleBook, book_id)
    if not book:
        raise HTTPException(404, "规则书不存在")
    for field in ("title", "language", "is_official", "source", "source_url"):
        val = getattr(body, field)
        if val is not None:
            setattr(book, field, val)
    await db.commit()
    await db.refresh(book)
    return await _to_out(db, book)


@router.delete("/rule-books/{book_id}")
async def delete_rule_book(book_id: int, db: AsyncSession = Depends(get_db)):
    """删除规则书：磁盘文件一并清理，切片由外键级联删除。"""
    book = await db.get(RuleBook, book_id)
    if not book:
        raise HTTPException(404, "规则书不存在")

    chunks = (
        await db.execute(
            select(func.count(RuleDocument.id)).where(RuleDocument.rule_book_id == book_id)
        )
    ).scalar() or 0

    await db.delete(book)
    await db.commit()

    removed_file = False
    try:
        path = _abs_path(book.file_path)
        if os.path.isfile(path):
            os.remove(path)
            removed_file = True
        elif os.path.isdir(path):
            shutil.rmtree(path)
            removed_file = True
    except Exception:  # noqa: BLE001 - 文件已丢也不影响数据库记录清理
        removed_file = False

    return {"detail": "已删除", "deleted_chunks": int(chunks), "removed_file": removed_file}


@router.post("/rule-books/{book_id}/build-docs", response_model=dict)
async def build_docs(
    book_id: int,
    mode: str = Form("replace"),
    db: AsyncSession = Depends(get_db),
):
    """从规则书生成规则文档（切片 + 向量）。

    一本书可以反复重建：replace=先清掉这本书的旧切片再写，append=追加。
    PDF 走 pypdf 抽字，图片包逐页 OCR（视觉模型），与规则文档页上传同一套分块/向量逻辑。
    """
    from app.api.admin.rule_docs import _embed, _extract_text, _split

    if mode not in ("replace", "append"):
        raise HTTPException(400, "mode 只能是 replace 或 append")

    book = await db.get(RuleBook, book_id)
    if not book:
        raise HTTPException(404, "规则书不存在")

    path = _abs_path(book.file_path)

    # 1. 抽取文本
    if book.file_type == "pdf":
        if not os.path.isfile(path):
            raise HTTPException(404, "规则书文件已丢失")
        with open(path, "rb") as fh:
            text, source = await _extract_text(os.path.basename(path), fh.read())
        page_count = book.page_count
    else:  # images：逐页 OCR
        pages = _pages_of_dir(path)
        if not pages:
            raise HTTPException(400, "图片目录为空，没有可识别的规则书页")
        texts: list[str] = []
        for i, pg in enumerate(pages, 1):
            with open(os.path.join(path, pg), "rb") as fh:
                t, source = await _extract_text(pg, fh.read())
            if t.strip():
                texts.append(f"【第 {i} 页】\n{t}")
        text = "\n\n".join(texts)
        page_count = len(pages)

    if not text.strip():
        raise HTTPException(400, "未能从规则书中抽取到任何文本")

    # 2. 切片 + 向量
    _, chunks = _split(text)
    if not chunks:
        raise HTTPException(400, "切片结果为空")

    if mode == "replace":
        await db.execute(
            delete(RuleDocument).where(RuleDocument.rule_book_id == book_id)
        )
        start = 0
    else:
        last = (
            await db.execute(
                select(func.coalesce(func.max(RuleDocument.chunk_index), -1)).where(
                    RuleDocument.rule_book_id == book_id
                )
            )
        ).scalar() or -1
        start = int(last) + 1

    vectors = await _embed([c.text for c in chunks])
    for i, c in enumerate(chunks):
        db.add(RuleDocument(
            game_id=book.game_id,
            rule_book_id=book_id,
            chunk_index=start + i,
            content=c.text,
            parent_index=start + c.parent_index,
            parent_text=c.parent_text,
            embedding=vectors[i] if vectors else None,
        ))
    if page_count:
        book.page_count = page_count
    await db.commit()

    total, vec = await _counts(db, book_id)
    return {
        "detail": "已生成规则文档",
        "rule_book_id": book_id,
        "added": len(chunks),
        "chunk_count": total,
        "vectorized": total > 0 and vec == total,
        "source": source,
    }


@router.post("/rule-books/{book_id}/register-pages", response_model=RuleBookOut)
async def register_pages(book_id: int, db: AsyncSession = Depends(get_db)):
    """图片型规则书：重新扫描目录，回写页数（手动往目录加了页后用它刷新）。"""
    book = await db.get(RuleBook, book_id)
    if not book:
        raise HTTPException(404, "规则书不存在")
    if book.file_type != "images":
        raise HTTPException(400, "只有图片型规则书需要扫描页码")
    pages = _pages_of_dir(_abs_path(book.file_path))
    book.page_count = len(pages)
    await db.commit()
    await db.refresh(book)
    return await _to_out(db, book, with_pages=True)
