"""可选的重排（Rerank）阶段：把混合检索融合后的 Top-N 候选，再做一次精细化排序。

为什么单独成模块、默认关闭：
- 原 pipeline 的「Rerank」其实是「归一化分数加权融合 + 章节感知加权」(rag._hybrid_order)，
  属于**无监督的规则化重排**，没有引入模型。这在候选集小（单款游戏的规则书切片通常 < 40 段）、
  且 BM25 已能抓住稀有词时已经够用，也是命中率能到 hit@5≈96% 的原因。
- 但当问题措辞与规则书差异大、或候选跨多款游戏时，规则化融合仍可能把正确切片压在 4~18 位。
  真正的神经重排（cross-encoder / 大模型裁判）能进一步纠正。本项目把它做成**可插拔**：
  默认用 gte-rerank-v2（真实交叉编码器），也可切回 llm / score，或整体关闭。

提供三种 method：
- "gte"：调用百炼 gte-rerank-v2（cross-encoder 语义重排），一次 HTTP 调用给全部候选打分。
  这是**默认启用**的真实神经重排：分数直接来自 rerank 模型，比让大模型逐段写分数更稳、更便宜。
- "llm"：点式重排。让大模型给每段候选打 1~5 的相关分（只比"相关/不相关"，不要求它生成），
  再按分数重排。代价是 N 段各调一次 LLM（或一次批量打分），故只在开启了 RERANK_ENABLED 时启用，
  且 RERANK_TOP_N 控制在 15 以内。
- "score"：调用方已持有每段分数时，按分数重排（零额外开销，等价于一个更显式的排序封装）。

任何异常都回落到进入本函数前的顺序，绝不拖垮主流程。
"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence

import httpx

from app.agent import llm
from app.core.config import settings

log = logging.getLogger(__name__)

# 复用的 httpx 异步客户端（连接池复用；rerank 是检索链路上的高频调用）。
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient()
    return _client


# 点式打分提示词：只判相关度，不要求模型复述内容，降低思维链/幻觉风险。
_RERANK_PROMPT = """你是桌游规则检索的「相关性裁判」。下面会给若干段【规则说明书原文切片】和一个【问题】。
请只判断每段与问题的相关程度，用 1~5 的整数打分（5=直接回答该问题，1=完全无关）。

要求：
1. 只输出一个 JSON 数组，长度等于切片数量，顺序与输入一致，每个元素是 1~5 的整数。
   例：[{"idx":1,"score":5},{"idx":2,"score":2}]
2. 不要解释，不要 Markdown，不要输出数组以外的任何文字。
3. 严格按输入顺序给分；只看切片本身是否包含回答该问题所需的事实，不联想、不补全。

问题：{query}

{chunks_block}"""


def _pointwise_scores(scores: Sequence[float]) -> list[tuple[int, float]]:
    """把「下标 → 分数」整理成按分数降序的 (idx, score) 列表（纯函数，便于单测）。"""
    return sorted(((i, float(s)) for i, s in enumerate(scores)), key=lambda x: (-x[1], x[0]))


def _rerank_by_scores(
    candidates: list[tuple[int, str]], scores: Sequence[float]
) -> list[tuple[int, str]]:
    """按已有分数对候选重排（可插拔重排的一个零成本实现）。"""
    if len(scores) != len(candidates):
        return candidates
    order = _pointwise_scores(scores)
    return [candidates[i] for i, _ in order]


def _parse_judge(raw: str, n: int) -> list[int] | None:
    """从模型输出里尽量抠出长度为 n 的整数分数列表。失败返回 None（调用方回落）。"""
    if not raw:
        return None
    m = re.search(r"\[.*\]", raw, re.DOTALL)
    blob = m.group(0) if m else raw
    try:
        arr = json.loads(blob)
    except (ValueError, TypeError):
        return None
    out: list[int] = []
    for item in arr:
        if isinstance(item, dict):
            v = item.get("score")
        else:
            v = item
        try:
            out.append(int(round(float(v))))
        except (TypeError, ValueError):
            return None
    if len(out) != n:
        return None
    return [max(1, min(5, s)) for s in out]


def _build_chunks_block(candidates: list[tuple[int, str]]) -> str:
    lines: list[str] = []
    for i, (_idx, text) in enumerate(candidates, 1):
        snippet = (text or "").strip().replace("\n", " ")
        if len(snippet) > 220:
            snippet = snippet[:220] + "…"
        lines.append(f"【切片{i}】{snippet}")
    return "\n".join(lines)


def _gte_order(scores: list[float | None]) -> list[int]:
    """把 rerank 接口返回的分数整理成排序下标；缺失分数的候选排最后（保持相对顺序）。

    纯函数，便于自检：接口按 index 返回分数，不保证顺序，故必须按 index 回填后自行排序。
    """
    return sorted(
        range(len(scores)),
        key=lambda i: (scores[i] is None, -(scores[i] or 0.0), i),
    )


async def _gte_rerank(
    query: str, candidates: list[tuple[int, str]]
) -> list[tuple[int, str]] | None:
    """调用百炼 gte-rerank-v2 给候选打相关性分并重排；失败返回 None 由调用方回落。

    请求体（DashScope 原生协议，非 OpenAI 兼容）：
    {"model","input":{"query","documents"},"parameters":{"return_documents":false,"top_n"}}
    返回：output.results = [{"index": 原下标, "relevance_score": 0~1}]。
    """
    if not (settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY) or not settings.RERANK_BASE_URL.strip():
        return None
    docs = [(text or "").strip() for _idx, text in candidates]
    if not any(docs):
        return None
    payload = {
        "model": settings.RERANK_MODEL,
        "input": {"query": query, "documents": docs},
        "parameters": {"return_documents": False, "top_n": len(docs)},
    }
    try:
        resp = await _get_client().post(
            settings.RERANK_BASE_URL,
            headers={
                "Authorization": f"Bearer {settings.DASHSCOPE_API_KEY or settings.LLM_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=httpx.Timeout(settings.RERANK_TIMEOUT, connect=10),
        )
    except httpx.HTTPError as e:
        log.warning("Rerank(gte) 网络异常，回落融合顺序：%s", e)
        return None
    if resp.status_code != 200:
        log.warning(
            "Rerank(gte) HTTP %s，回落融合顺序：%s", resp.status_code, resp.text[:200]
        )
        return None
    try:
        results = (resp.json().get("output") or {}).get("results") or []
        scores: list[float | None] = [None] * len(candidates)
        for item in results:
            idx = int(item.get("index"))
            if 0 <= idx < len(scores):
                scores[idx] = float(item.get("relevance_score") or 0.0)
    except (ValueError, TypeError, AttributeError) as e:
        log.warning("Rerank(gte) 返回结构异常，回落融合顺序：%s", e)
        return None
    if all(s is None for s in scores):
        return None
    return [candidates[i] for i in _gte_order(scores)]


async def rerank_rule_chunks(
    query: str,
    candidates: list[tuple[int, str]],
    *,
    scores: Sequence[float] | None = None,
    method: str | None = None,
    top_n: int | None = None,
) -> list[tuple[int, str]]:
    """对候选 (chunk_index, 原文) 做精细化重排，返回重排后的候选。

    任何异常都原样返回 candidates（调用方在 rag 里也已 try/except 兜底），
    保证「开启重排」最坏情况只是「没重排」，绝不影响回答正确性。
    """
    if not candidates:
        return candidates

    method = method or settings.RERANK_METHOD
    top_n = top_n or settings.RERANK_TOP_N

    # 0) gte-rerank-v2：一次调用给全部候选打分（调用方已用 RERANK_TOP_N 截断过）
    if method == "gte":
        reranked = await _gte_rerank(query, candidates)
        return reranked if reranked else candidates

    # 1) 分数重排：调用方已经有可信分数时，零成本
    if method == "score" and scores is not None:
        return _rerank_by_scores(candidates, scores)

    # 2) LLM 裁判重排：只对前 top_n 个候选打分（其余保持原序追加在后）
    if method == "llm":
        if not llm.available():
            return candidates
        head = candidates[:top_n]
        tail = candidates[top_n:]
        try:
            raw = await llm.chat_complete(
                [
                    {
                        "role": "system",
                        "content": "你是严谨的检索相关性裁判，只输出结构化评分。",
                    },
                    {
                        "role": "user",
                        "content": _RERANK_PROMPT.format(
                            query=query, chunks_block=_build_chunks_block(head)
                        ),
                    },
                ],
                temperature=0.0,
                max_tokens=512,
                model=settings.LLM_RULE_MODEL or settings.LLM_MODEL,
                enable_thinking=False,
            )
            scored = _parse_judge(raw, len(head))
            if scored is None:
                return candidates
            ordered = sorted(
                ((i, s) for i, s in enumerate(scored)), key=lambda x: (-x[1], x[0])
            )
            return [head[i] for i, _ in ordered] + tail
        except Exception as e:  # noqa: BLE001
            log.warning("Rerank(llm) 失败，回落到融合顺序：%s", e)
            return candidates

    return candidates


if __name__ == "__main__":
    # 自检：不依赖 DB/LLM，验证纯函数排序正确。
    cands = [(10, "a"), (3, "b"), (7, "c"), (1, "d")]
    sc = [0.2, 0.9, 0.5, 0.1]
    out = _rerank_by_scores(cands, sc)
    assert [i for i, _ in out] == [3, 7, 10, 1], out
    # gte 分数可能缺失/乱序：缺失排最后，其余按分数降序
    assert _gte_order([0.2, 0.9, None, 0.5]) == [1, 3, 0, 2]
    assert _gte_order([None, None]) == [0, 1]
    print("rerank self-test OK:", [(i, round(s, 2)) for i, s in _pointwise_scores(sc)])
