# -*- coding: utf-8 -*-
"""从站内规则书扫描页重建 RAG 语料（rule_books + rule_documents）。

背景：本地 pgdata 被误删后，规则书切片与向量全部丢失；原始扫描页随仓库分发在
frontend/public/rules/<slug>/。本脚本按线上同一套链路重跑一遍入库：
登记规则书 → 逐页 OCR（视觉模型）→ 语义切片 → 向量化 → 写 rule_documents。

OCR 结果缓存在 logs/rule_ocr/<slug>/<page>.txt，中断后重跑只补缺页。

用法（项目根目录）：
    $env:PYTHONPATH="backend"
    python backend/seed_rulebooks.py                 # 全部（已有切片的书跳过）
    python backend/seed_rulebooks.py --only catan,san-guo-sha
    python backend/seed_rulebooks.py --rebuild       # 已有切片的书也重做
    python backend/seed_rulebooks.py --workers 3     # OCR 并发页数（默认 3）
"""
import asyncio
import json
import os
import re
import sys
import time

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.admin.rule_docs import _embed, _extract_text, _split
from app.core.database import engine
from app.models.board_game import BoardGame
from app.models.rule_book import RuleBook
from app.models.rule_document import RuleDocument

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES_DIR = os.path.join(ROOT, "frontend", "public", "rules")
CATALOG = os.path.join(ROOT, "backend", "data", "catalog.json")
OCR_CACHE = os.path.join(ROOT, "logs", "rule_ocr")

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def arg_value(flag: str, default: str | None = None) -> str | None:
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


ONLY = {s.strip() for s in (arg_value("--only") or "").split(",") if s.strip()}
REBUILD = "--rebuild" in sys.argv
WORKERS = max(1, int(arg_value("--workers", "3") or 3))


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def pages_of(slug: str) -> list[str]:
    d = os.path.join(RULES_DIR, slug)
    if not os.path.isdir(d):
        return []
    files = [f for f in os.listdir(d) if f.lower().endswith(IMAGE_EXTS)]
    return sorted(files, key=lambda f: int("".join(re.findall(r"\d+", f)) or 0))


def slug_to_id() -> dict[str, int]:
    """catalog.json 没有 slug 字段，用封面路径 /games/<slug>/cover.jpg 反推。"""
    catalog = json.load(open(CATALOG, encoding="utf-8"))
    out: dict[str, int] = {}
    for c in catalog:
        m = re.search(r"/games/([^/]+)/", c.get("cover_image") or "")
        if m:
            out[m.group(1)] = int(c["id"])
    return out


def cjk_ratio(text: str) -> float:
    if not text:
        return 0.0
    n = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return n / len(text)


async def ocr_page(path: str, cache: str, sem: asyncio.Semaphore) -> str:
    """一页 OCR；命中缓存直接返回，失败重试一次，仍失败返回空串。"""
    if os.path.isfile(cache) and os.path.getsize(cache) > 0:
        with open(cache, encoding="utf-8") as fh:
            return fh.read()
    err = ""
    async with sem:
        for attempt in (1, 2):
            try:
                with open(path, "rb") as fh:
                    text, _ = await _extract_text(os.path.basename(path), fh.read())
                if text.strip():
                    os.makedirs(os.path.dirname(cache), exist_ok=True)
                    with open(cache, "w", encoding="utf-8") as fh:
                        fh.write(text)
                    return text
                err = "OCR 返回空内容"
            except Exception as e:  # noqa: BLE001 - 单页失败不影响整本
                err = str(e)[:200]
            await asyncio.sleep(3)
    log(f"    ! {os.path.basename(path)} OCR 失败：{err}")
    return ""


async def build_book(session: AsyncSession, slug: str, game_id: int, game_name: str) -> tuple[int, int, int]:
    pages = pages_of(slug)
    if not pages:
        return 0, 0, 0

    sem = asyncio.Semaphore(WORKERS)
    tasks = [
        ocr_page(
            os.path.join(RULES_DIR, slug, pg),
            os.path.join(OCR_CACHE, slug, f"{pg}.txt"),
            sem,
        )
        for pg in pages
    ]
    texts = await asyncio.gather(*tasks)
    failed = sum(1 for t in texts if not t.strip())

    body = "\n\n".join(
        f"【第 {i} 页】\n{t}" for i, t in enumerate(texts, 1) if t.strip()
    )
    if not body.strip():
        log(f"  × {slug}: 全部页面 OCR 失败，跳过（不登记规则书）")
        return 0, 0, failed

    book = (
        await session.execute(
            select(RuleBook).where(
                RuleBook.game_id == game_id, RuleBook.file_path == f"/rules/{slug}"
            )
        )
    ).scalars().first()
    if book is None:
        book = RuleBook(
            game_id=game_id,
            title=f"{game_name} 规则书",
            file_type="images",
            file_path=f"/rules/{slug}",
            page_count=len(pages),
            language="zh",
            is_official=True,
            source="站内扫描页 OCR（seed_rulebooks）",
        )
        session.add(book)
        await session.commit()
        await session.refresh(book)

    had_docs = (
        await session.execute(
            select(func.count(RuleDocument.id)).where(RuleDocument.rule_book_id == book.id)
        )
    ).scalar() or 0

    book.page_count = len(pages)
    # 中文占比超过 15% 视为中文规则书，否则记英文
    book.language = "zh" if cjk_ratio(body) >= 0.15 else "en"
    await session.commit()

    _, chunks = _split(body)
    vectors = await _embed([c.text for c in chunks])

    await session.execute(delete(RuleDocument).where(RuleDocument.rule_book_id == book.id))
    for i, c in enumerate(chunks):
        session.add(
            RuleDocument(
                game_id=game_id,
                rule_book_id=book.id,
                chunk_index=i,
                content=c.text,
                parent_index=c.parent_index,
                parent_text=c.parent_text,
                embedding=vectors[i] if vectors else None,
            )
        )
    await session.commit()
    log(
        f"  ✓ {slug}: {len(pages)} 页 / {len(chunks)} 切片 / "
        f"{'已向量化' if vectors else '无向量'} / 失败 {failed} 页"
        + ("（替换旧切片）" if had_docs else "")
    )
    return len(pages), len(chunks), failed


async def main() -> None:
    mapping = slug_to_id()
    slugs = [s for s in mapping if os.path.isdir(os.path.join(RULES_DIR, s))]
    if ONLY:
        slugs = [s for s in slugs if s in ONLY]
    if not slugs:
        log("没有匹配到任何规则书目录")
        return

    total_books = total_pages = total_chunks = total_failed = 0
    async with SessionLocal() as session:
        for idx, slug in enumerate(sorted(slugs), 1):
            game_id = mapping[slug]
            game = await session.get(BoardGame, game_id)
            if game is None:
                log(f"  × {slug}: 桌游 id={game_id} 不在库中，跳过")
                continue

            docs = (
                await session.execute(
                    select(func.count(RuleDocument.id))
                    .join(RuleBook, RuleDocument.rule_book_id == RuleBook.id)
                    .where(RuleBook.game_id == game_id, RuleBook.file_path == f"/rules/{slug}")
                )
            ).scalar() or 0
            if docs and not REBUILD:
                log(f"  · {slug}: 已有 {docs} 切片，跳过（--rebuild 可重做）")
                continue

            log(f"[{idx}/{len(slugs)}] {game.name}（{slug}）")
            pages, chunks, failed = await build_book(session, slug, game_id, game.name)
            total_books += 1 if chunks else 0
            total_pages += pages
            total_chunks += chunks
            total_failed += failed

            if pages and not chunks:
                log(
                    "OCR 不可用（额度耗尽或视觉模型全部拒绝），本轮停止。"
                    "已完成的书与 logs/rule_ocr 缓存会保留，稍后重跑即可续上。"
                )
                break

    log(
        f"完成：{total_books} 本 / {total_pages} 页 / {total_chunks} 切片"
        + (f" / {total_failed} 页 OCR 失败（重跑可补）" if total_failed else "")
    )


if __name__ == "__main__":
    asyncio.run(main())
