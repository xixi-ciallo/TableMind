"""管理员端规则说明书上传：解析文本 -> 语义分块 -> 落库（有 LLM Key 时再向量化）。

分块策略见 `app/agent/rulebook.py`：优先按 Markdown 标题做**语义分块**（章节即语义单元），
只有单节超长时才退化为按段落/句子切并保留重叠；同时先清洗页眉页脚/页码/乱码。
不再按固定字数硬切——那会把「费用」「例外」这类完整规则从中间截断，是规则类 RAG 的典型坑。

未配置 LLM_API_KEY 时仍会真实保存切片，但 embedding 为 null、vectorized=false，
接口如实返回状态，不做任何"已向量化"的虚假标记。

支持三种来源：
- PDF：pypdf 抽取文字
- 文本 / Markdown：直接解码
- **规则书图片**：调用视觉/OCR 大模型（qwen3.5-ocr，额度不可用时自动回退）逐页 OCR 转文字后入库，
  配合 `mode=append` 可把一本说明书的多页图片按顺序累积成一份完整规则书。
"""
import asyncio
import base64
import io
import logging
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import rulebook
from app.api.deps import get_db
from app.core.config import settings
from app.models.board_game import BoardGame
from app.models.rule_document import RuleDocument
from app.schemas.admin import (
    RuleChunkItem,
    RuleChunkUpdate,
    RuleDocStatus,
    RuleDocSummary,
    RuleDocUploadResult,
)

router = APIRouter()
log = logging.getLogger(__name__)

MAX_BYTES = 20 * 1024 * 1024
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif")
# 视觉/OCR 模型候选链：前一个不可用时（免费额度耗尽、未开通等）自动回退到下一个。
# 顺序按 2026-10-14 实测的可用性排：
#   qwen3.5-ocr / qwen-vl-ocr / qwen3-vl-plus 均 403 AllocationQuota.FreeTierOnly，
#   只有 qwen-vl-ocr-2025-11-20 仍返回 200（同一账号下不同模型走不同配额）。
#   把可用的排在首位，避免每次上传都先白失败两次再回退。
# 说明：qwen-vl-ocr 系列会用 HTML 标签表达排版，入库前由 _strip_markup 还原为纯文本。
VISION_MODELS = ("qwen-vl-ocr-2025-11-20", "qwen3.5-ocr", "qwen-vl-ocr", "qwen3-vl-plus")

OCR_PROMPT = (
    "请完整、忠实地识别图片中的规则书正文文字。"
    "要求：1) 按从上到下、从左到右的阅读顺序逐段输出；"
    "2) 保留标题、段落、列表与表格结构；"
    "3) 不要翻译、不要改写、不要省略、不要添加图片中没有的内容；"
    "4) 只输出正文，不要任何说明或评论。"
)


def _encode_image(raw: bytes) -> str:
    """压缩并转 base64（同步 CPU 密集，放在线程里跑）。

    长边压到 2000px：既保证竖排小字仍可辨认，又避免超出视觉模型输入上限。
    """
    from PIL import Image

    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    if w > 2000:
        im = im.resize((2000, int(h * 2000 / w)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


_TAG_RE = re.compile(r"<[^>]{1,200}>")
_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")


def _strip_markup(text: str) -> str:
    """去掉 OCR 模型输出里的 ```html 围栏与标签，还原为纯文本。

    qwen-vl-ocr 系列习惯用 HTML 标签表达排版，直接入库会把标签混进切片正文。
    """
    t = (text or "").strip()
    if not t:
        return ""
    t = _FENCE_RE.sub("", t).strip()
    if "<" in t and ">" in t:
        t = re.sub(r"(?i)<(br|/p|/div|/h[1-6]|/li|/tr)\s*/?>", "\n", t)
        t = _TAG_RE.sub("", t)
        t = (t.replace("&nbsp;", " ").replace("&amp;", "&")
              .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    t = re.sub(r"[ \t]+", " ", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def _to_simplified(text: str) -> str:
    """繁体转简体（规则书扫描件多为繁体）。opencc 缺失时原样返回，不猜测。"""
    try:
        from opencc import OpenCC

        return OpenCC("t2s").convert(text)
    except Exception:  # noqa: BLE001 - 转换器可选
        return text


async def _ocr_image(raw: bytes) -> str:
    """调用视觉大模型识别规则书图片中的文字。"""
    if not (settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY):
        raise HTTPException(400, "未配置 DASHSCOPE_API_KEY，无法识别图片，请改传 PDF 或文本")
    try:
        import httpx
    except ImportError as e:  # pragma: no cover
        raise HTTPException(500, "服务端未安装 httpx，无法调用视觉模型") from e

    b64 = await asyncio.to_thread(_encode_image, raw)
    base = (settings.DASHSCOPE_BASE_URL or "").rstrip("/")

    last_err = ""
    content = ""
    for model in VISION_MODELS:
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                        {"type": "text", "text": OCR_PROMPT},
                    ],
                }
            ],
            "max_tokens": 4000,
        }
        try:
            async with httpx.AsyncClient(timeout=180) as client:
                resp = await client.post(
                    f"{base}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY}"},
                    json=payload,
                )
        except Exception as e:  # noqa: BLE001
            last_err = f"视觉模型请求失败：{e}"
            continue

        if resp.status_code >= 400:
            last_err = f"视觉模型 {model} 返回 {resp.status_code}：{resp.text[:200]}"
            continue
        try:
            content = resp.json()["choices"][0]["message"]["content"] or ""
        except Exception as e:  # noqa: BLE001
            last_err = f"视觉模型 {model} 返回内容无法解析：{e}"
            continue
        if content.strip():
            break
        last_err = f"视觉模型 {model} 返回空内容"

    if not content.strip():
        raise HTTPException(502, f"所有视觉模型均不可用（{last_err}）")

    text = _to_simplified(_strip_markup(content))
    if not text:
        raise HTTPException(400, "这张图片没有识别到任何文字，请换一张更清晰的规则书页")
    return text


async def _extract_text(filename: str, raw: bytes) -> tuple[str, str]:
    """按文件类型抽取纯文本，返回 (文本, 来源标识)。

    图片走视觉模型 OCR；PDF 用 pypdf；其余按文本解码。
    """
    lower = (filename or "").lower()

    if lower.endswith(IMAGE_EXTS):
        return await _ocr_image(raw), "image-ocr"

    if lower.endswith(".pdf"):
        try:
            from pypdf import PdfReader
        except ImportError as e:  # pragma: no cover
            raise HTTPException(500, "服务端未安装 pypdf，无法解析 PDF") from e
        try:
            reader = PdfReader(io.BytesIO(raw))
            return "\n".join((p.extract_text() or "") for p in reader.pages), "pdf"
        except Exception as e:
            raise HTTPException(400, f"PDF 解析失败：{e}") from e

    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc), "text"
        except UnicodeDecodeError:
            continue
    raise HTTPException(400, "无法识别文件编码，请上传 UTF-8 文本、PDF 或规则书图片")


def _split(text: str) -> tuple[dict, list[rulebook.PreparedChunk]]:
    """语义分块（委托给 app/agent/rulebook.py）。

    返回 (frontmatter 元数据, 切片列表)：
    - 有 Markdown 标题时按标题切，每片带「《游戏名》/ 章节路径」上下文头；
    - 无标题的纯文本（OCR 稿、老格式）退化为按段落打包 + 重叠，仍不硬切段落；
    - 每片同时携带父章节（parent_index / parent_text），供检索时父块回填。
    """
    return rulebook.chunk_rule_doc(text)


async def _embed(texts: list[str]) -> list[list[float]] | None:
    """有百炼密钥时调用 embedding 接口；否则返回 None。

    按批调用（百炼 embedding 接口支持 input 数组），避免上百片逐个请求导致
    上传超时；批量失败时自动回退为逐条调用，保证成功率优先。
    """
    if not (settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY):
        return None
    try:
        from openai import AsyncOpenAI
    except ImportError:
        return None

    client = AsyncOpenAI(
        api_key=settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY,
        base_url=settings.DASHSCOPE_BASE_URL,
    )
    model = getattr(settings, "EMBEDDING_MODEL", "text-embedding-v4")
    dim = getattr(settings, "EMBEDDING_DIM", None)
    extra = {"dimensions": dim} if dim else {}
    BATCH = 25

    out: list[list[float]] = []
    for i in range(0, len(texts), BATCH):
        # 百炼 text-embedding-v1 单条输入上限 2048，超长会被整个批次拒绝
        batch = [t[:2000] for t in texts[i : i + BATCH]]
        try:
            resp = await client.embeddings.create(model=model, input=batch, **extra)
            out.extend(d.embedding for d in sorted(resp.data, key=lambda d: d.index))
        except Exception:  # noqa: BLE001 - 批量失败则逐条兜底
            for t in batch:
                resp = await client.embeddings.create(model=model, input=t, **extra)
                out.append(resp.data[0].embedding)
    return out


@router.post("/games/{game_id}/rule-docs", response_model=RuleDocUploadResult)
async def upload_rule_doc(
    game_id: int,
    file: UploadFile = File(...),
    mode: str = Form("replace"),
    db: AsyncSession = Depends(get_db),
):
    """上传一页/一份说明书。

    mode=replace（默认）：清空该桌游旧切片后写入，适合整本 PDF / 文本。
    mode=append：接在现有切片后面继续写，适合把一本规则书的多张页面图片逐页累积。
    """
    if mode not in ("replace", "append"):
        raise HTTPException(400, "mode 只能是 replace 或 append")

    game = await db.get(BoardGame, game_id)
    if not game:
        raise HTTPException(404, "桌游不存在")

    raw = await file.read()
    if not raw:
        raise HTTPException(400, "文件为空")
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "文件超过 20MB 上限")

    text, source = await _extract_text(file.filename or "", raw)
    meta, chunks = _split(text)
    if not chunks:
        raise HTTPException(400, "未能从文件中抽取到任何文本")
    if meta:
        log.info("规则文档 frontmatter（game_id=%s）：%s", game_id, meta)

    start = 0
    if mode == "append":
        last = (
            await db.execute(
                select(func.coalesce(func.max(RuleDocument.chunk_index), -1)).where(
                    RuleDocument.game_id == game_id
                )
            )
        ).scalar() or -1
        start = int(last) + 1
    else:
        # 整本替换：先清空旧切片，避免新旧混在一起
        await db.execute(delete(RuleDocument).where(RuleDocument.game_id == game_id))

    vectors = await _embed([c.text for c in chunks])
    for i, c in enumerate(chunks):
        db.add(RuleDocument(
            game_id=game_id,
            chunk_index=start + i,
            content=c.text,
            parent_index=start + c.parent_index,
            parent_text=c.parent_text,
            embedding=vectors[i] if vectors else None,
        ))
    await db.commit()

    total, vec = await _counts(db, game_id)
    return RuleDocUploadResult(
        game_id=game_id,
        chunk_count=total,
        added=len(chunks),
        vectorized=total > 0 and vec == total,
        mode=mode,
        source=source,
    )


async def _counts(db: AsyncSession, game_id: int) -> tuple[int, int]:
    """返回 (切片总数, 已向量化数)。"""
    total = (
        await db.execute(
            select(func.count(RuleDocument.id)).where(RuleDocument.game_id == game_id)
        )
    ).scalar() or 0
    vec = (
        await db.execute(
            select(func.count(RuleDocument.id)).where(
                RuleDocument.game_id == game_id,
                RuleDocument.embedding.isnot(None),
            )
        )
    ).scalar() or 0
    return int(total), int(vec)


@router.get("/games/{game_id}/rule-docs", response_model=RuleDocStatus)
async def get_rule_doc_status(game_id: int, db: AsyncSession = Depends(get_db)):
    total, vec = await _counts(db, game_id)
    return RuleDocStatus(
        game_id=game_id,
        chunk_count=total,
        vectorized=total > 0 and vec == total,
    )


@router.get("/rule-docs", response_model=list[RuleDocSummary])
async def list_rule_docs(db: AsyncSession = Depends(get_db)):
    """按桌游聚合已有规则文档。

    管理端首屏直接展示「库里已有哪些说明书」，不必先猜游戏名再逐个查询。
    """
    rows = (
        await db.execute(
            select(
                RuleDocument.game_id,
                BoardGame.name.label("game_name"),
                func.count(RuleDocument.id).label("chunk_count"),
                func.count(RuleDocument.embedding).label("vec_count"),
            )
            .outerjoin(BoardGame, BoardGame.id == RuleDocument.game_id)
            .group_by(RuleDocument.game_id, BoardGame.name)
            .order_by(RuleDocument.game_id)
        )
    ).all()

    return [
        RuleDocSummary(
            game_id=int(r.game_id),
            game_name=r.game_name,
            chunk_count=int(r.chunk_count),
            vectorized=int(r.vec_count) == int(r.chunk_count),
        )
        for r in rows
    ]


@router.get("/games/{game_id}/rule-docs/chunks", response_model=list[RuleChunkItem])
async def get_rule_doc_chunks(
    game_id: int,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """返回某桌游的规则切片内容（按顺序），供管理端预览实际切分结果。"""
    rows = (
        await db.execute(
            select(RuleDocument)
            .where(RuleDocument.game_id == game_id)
            .order_by(RuleDocument.chunk_index)
            .limit(max(1, min(limit, 200)))
        )
    ).scalars().all()

    return [
        RuleChunkItem(
            chunk_index=r.chunk_index,
            content=r.content,
            char_count=len(r.content or ""),
            has_embedding=r.embedding is not None,
        )
        for r in rows
    ]


@router.put(
    "/games/{game_id}/rule-docs/chunks/{chunk_index}", response_model=RuleChunkItem
)
async def update_rule_chunk(
    game_id: int,
    chunk_index: int,
    body: RuleChunkUpdate,
    db: AsyncSession = Depends(get_db),
):
    """修正某条切片文字（OCR 错字、缺段落等），保存后自动重新向量化该片。"""
    row = (
        await db.execute(
            select(RuleDocument).where(
                RuleDocument.game_id == game_id,
                RuleDocument.chunk_index == chunk_index,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "该切片不存在")

    content = (body.content or "").strip()
    if not content:
        raise HTTPException(400, "切片内容不能为空")

    row.content = content
    vectors = await _embed([content])
    row.embedding = vectors[0] if vectors else None
    await db.commit()

    return RuleChunkItem(
        chunk_index=row.chunk_index,
        content=row.content,
        char_count=len(row.content or ""),
        has_embedding=row.embedding is not None,
    )


@router.delete("/games/{game_id}/rule-docs/chunks/{chunk_index}")
async def delete_rule_chunk(
    game_id: int, chunk_index: int, db: AsyncSession = Depends(get_db)
):
    """删除单条切片（如 OCR 出乱码的页），并把后续切片序号整体前移，保持连续。"""
    res = await db.execute(
        delete(RuleDocument).where(
            RuleDocument.game_id == game_id,
            RuleDocument.chunk_index == chunk_index,
        )
    )
    if not (res.rowcount or 0):
        raise HTTPException(404, "该切片不存在")
    await db.execute(
        update(RuleDocument)
        .where(
            RuleDocument.game_id == game_id,
            RuleDocument.chunk_index > chunk_index,
        )
        .values(chunk_index=RuleDocument.chunk_index - 1)
    )
    await db.commit()
    total, _ = await _counts(db, game_id)
    return {"detail": "已删除", "deleted": 1, "chunk_count": total}


@router.post("/games/{game_id}/rule-docs/reembed", response_model=RuleDocStatus)
async def reembed_rule_docs(game_id: int, db: AsyncSession = Depends(get_db)):
    """给缺向量的切片补 embedding（上传时未配 Key / 接口抖动导致漏向量时用于兜底）。"""
    if not (settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY):
        raise HTTPException(400, "未配置 DASHSCOPE_API_KEY，无法生成向量")

    rows = (
        await db.execute(
            select(RuleDocument)
            .where(RuleDocument.game_id == game_id, RuleDocument.embedding.is_(None))
            .order_by(RuleDocument.chunk_index)
        )
    ).scalars().all()
    if not rows:
        total, vec = await _counts(db, game_id)
        return RuleDocStatus(
            game_id=game_id, chunk_count=total, vectorized=total > 0 and vec == total
        )

    vectors = await _embed([r.content for r in rows])
    if vectors:
        for r, v in zip(rows, vectors):
            r.embedding = v
        await db.commit()

    total, vec = await _counts(db, game_id)
    return RuleDocStatus(
        game_id=game_id, chunk_count=total, vectorized=total > 0 and vec == total
    )


@router.delete("/games/{game_id}/rule-docs")
async def delete_rule_docs(game_id: int, db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        delete(RuleDocument).where(RuleDocument.game_id == game_id)
    )
    await db.commit()
    return {"detail": "已删除", "deleted": res.rowcount or 0}
