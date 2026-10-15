"""规则说明书的「为检索而写」格式处理：YAML 前置元数据 + 语义分块 + 文本清洗。

设计要点（决定 RAG 能不能答准）：
1. **元数据**：Markdown 顶部的 YAML frontmatter 放游戏元数据（title / player_count /
   play_time / bgg_id 等）。分块时会把「游戏名 + 章节路径」写进每片的正文，
   让 embedding 同时带上「是哪款游戏、属于哪一节」的信号——纯正文切片经常丢这个信号。
2. **语义分块**：优先按 `#`/`##`/`###` 标题切（章节即语义单元），绝不把一条规则从中间截断。
   只有**单节本身超长**时才退化为按段落/句子切，并在边界处保留重叠。
   固定字数硬切是规则类 RAG 最典型的坑（会把「费用」「例外」拆到两片里）。
3. **文本清洗**：页眉页脚/页码/PDF 转换乱码这类样板文字会显著拉低检索质量，
   必须先清掉再切。

全部函数为纯函数，无 IO，便于单测。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---- 分块参数 ----
# Azure RAG 指南的起始建议约 512 tokens/块、重叠 10%-15%；规则文档以语义边界优先，
# 只有单节过长时才用这组数值兜底。
TARGET_TOKENS = 512
OVERLAP_RATIO = 0.12
MIN_CHUNK_TOKENS = 24  # 过短的碎片（如只有一句标题）并入上一片，避免噪声片

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*$")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)

# PDF 转换常见的控制字符 / 替换字符（\ufffd 是乱码占位符）
NOISE_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFD]")
# 纯页码行：123 / - 12 - / 第 12 页 / Page 12 of 30
PAGE_LINE_RE = re.compile(
    r"(?m)^\s*(?:第\s*\d{1,4}\s*页(?:\s*/\s*共\s*\d{1,4}\s*页)?"
    r"|page\s+\d{1,4}(?:\s+(?:of|/)\s+\d{1,4})?"
    r"|-?\s*\d{1,4}\s*-?)\s*$",
    re.IGNORECASE,
)


@dataclass
class Chunk:
    """一个语义切片。section_path 是该片所处的章节路径（用于拼接上下文头）。"""

    section_path: list[str] = field(default_factory=list)
    text: str = ""

    @property
    def header(self) -> str:
        """拼成给模型看的上下文头，如「卡坦岛 > 回合流程 > 建造费用」"""
        return " > ".join(self.section_path)


def _estimate_tokens(text: str) -> int:
    """粗略估算 token 数（embedding 计费/长度用，不需要精确）。

    中文按 1 字 ≈ 1 token，其余（英文/数字/标点）按 4 字符 ≈ 1 token 近似。
    这是经验近似值，不同模型分词不同，仅用于判断是否超过 TARGET_TOKENS。
    """
    if not text:
        return 0
    cjk = len(re.findall(r"[\u4e00-\u9fff\u3040-\u30ff]", text))
    other = len(text) - cjk
    return int(cjk + other / 4)


def parse_frontmatter(md: str) -> tuple[dict, str]:
    """拆分 YAML frontmatter 与正文。

    返回 (metadata, body)。没有 frontmatter 时 metadata 为空 dict。
    不引入 PyYAML 依赖：规则文档的 frontmatter 只有简单的 `key: value`，
    用手写解析即可，避免为一个解析函数拉进一个依赖。
    """
    m = FRONTMATTER_RE.match(md or "")
    if not m:
        return {}, md or ""
    meta: dict = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip().strip("'\"")
        if key:
            meta[key] = val
    return meta, md[m.end() :]


def clean_text(text: str, min_repeat: int = 3) -> str:
    """清洗从 PDF / OCR 得到的文本：去控制字符、页码、重复页眉页脚。

    min_repeat：同一行出现 >= min_repeat 次且较短时视为页眉页脚并删除。
    """
    if not text:
        return ""

    out = text.replace("\r\n", "\n").replace("\r", "\n")
    out = NOISE_CHARS_RE.sub("", out)
    out = PAGE_LINE_RE.sub("", out)

    # 重复行（页眉页脚）统计：忽略空行与过长行
    counts: dict[str, int] = {}
    for line in out.split("\n"):
        s = line.strip()
        if s and len(s) <= 60:
            counts[s] = counts.get(s, 0) + 1
    boiler = {s for s, c in counts.items() if c >= min_repeat}

    lines = []
    for line in out.split("\n"):
        s = line.strip()
        if s and s in boiler:
            continue
        lines.append(s)

    out = "\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return out.strip()


def _split_oversized(text: str, target: int, overlap: int) -> list[str]:
    """单节过长时的兜底切分：先按段落打包，仍过长则按句子切，并保留重叠。"""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        paragraphs = [text]

    pieces: list[str] = []
    cur = ""
    for p in paragraphs:
        if _estimate_tokens(p) > target:
            # 单个段落就超长：按句号/分号/换行切句
            if cur:
                pieces.append(cur)
                cur = ""
            sents = re.split(r"(?<=[。！？；;.!?])\s*", p)
            buf = ""
            for s in sents:
                if _estimate_tokens(buf + s) > target and buf:
                    pieces.append(buf)
                    tail = buf[-overlap:] if overlap else ""
                    buf = tail + s
                else:
                    buf += s
            if buf:
                pieces.append(buf)
        elif _estimate_tokens(cur + "\n\n" + p) > target and cur:
            pieces.append(cur)
            tail = cur[-overlap:] if overlap else ""
            cur = (tail + "\n\n" + p).strip()
        else:
            cur = (cur + "\n\n" + p).strip() if cur else p
    if cur:
        pieces.append(cur)
    return [p for p in pieces if p.strip()]


def semantic_chunks(
    body: str,
    target_tokens: int = TARGET_TOKENS,
    overlap_ratio: float = OVERLAP_RATIO,
) -> list[Chunk]:
    """按 Markdown 标题层级做语义分块。

    - 每个「标题 → 下一个同级或更高级标题」之间的内容构成一个语义单元；
    - 章节路径（如 回合流程 > 建造费用）随切片一起返回，供拼上下文头；
    - 只有单节超过 target_tokens 时才启用的兜底切分，且带重叠。
    """
    if not body or not body.strip():
        return []

    overlap = max(0, int(target_tokens * overlap_ratio))

    sections: list[Chunk] = []
    stack: list[str] = []
    cur_path: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        text = "\n".join(buf).strip()
        if text:
            sections.append(Chunk(section_path=list(cur_path), text=text))
        buf.clear()

    for line in body.split("\n"):
        m = HEADING_RE.match(line)
        if m:
            flush()
            level = len(m.group(1))
            title = m.group(2).strip()
            stack = stack[: level - 1] + [title]
            cur_path = stack[:]
        else:
            buf.append(line)
    flush()

    out: list[Chunk] = []
    for sec in sections:
        if _estimate_tokens(sec.text) <= target_tokens:
            out.append(sec)
            continue
        for piece in _split_oversized(sec.text, target_tokens, overlap):
            out.append(Chunk(section_path=list(sec.section_path), text=piece))

    # 合并过短碎片：只允许合并**同一章节**内的碎片（即超长节切分产生的零头）。
    # 绝不能跨章节合并——那会把「组件清单」并进「边界情况」这类不相关章节，
    # 直接违背「章节即语义单元」的原则；短章节本身就是一个完整语义单元，应独立成片。
    merged: list[Chunk] = []
    for c in out:
        if (
            merged
            and _estimate_tokens(c.text) < MIN_CHUNK_TOKENS
            and merged[-1].section_path == c.section_path
        ):
            merged[-1].text = (merged[-1].text + "\n" + c.text).strip()
        else:
            merged.append(c)
    return merged


def chunk_rule_doc(md_text: str, target_tokens: int = TARGET_TOKENS) -> tuple[dict, list[str]]:
    """规则文档 -> 可入库的切片文本列表。

    返回 (frontmatter 元数据, 切片列表)。每片开头会带上
    「《游戏名》/ 章节路径」上下文头——这样 embedding 能感知语义归属，
    检索命中后模型也能直接知道这段来自哪一节。
    """
    meta, body = parse_frontmatter(md_text)
    body = clean_text(body)
    chunks = semantic_chunks(body, target_tokens=target_tokens)

    title = (meta.get("title") or "").strip()
    out: list[str] = []
    for c in chunks:
        head_parts: list[str] = []
        if title:
            head_parts.append(f"《{title}》")
        if c.header:
            head_parts.append(c.header)
        head = " / ".join(head_parts)
        out.append(f"【{head}】\n{c.text}" if head else c.text)
    return meta, out
