"""热点规则问答答案缓存。

目标：高频或近似重复的规则问题直接返回已生成的答案，首字延迟≈0，绕开
「改写 LLM + 生成 LLM（推理模型思维链）」这一长链路。

设计要点：
- key = 游戏 id + 归一化问题；近似命中用 embedding 余弦 ≥ ANSWER_CACHE_SIMILARITY。
- 进程内 LRU（上限 _MAX），TTL 由 ANSWER_CACHE_TTL_SEC 控制；进程重启即清空（可接受，TTL 兜底）。
- 只缓存依据明确的层级（L1 结构化 / L2 规则书 / L3 BGG），绝不缓存 L4（未验证），
  避免把「本站无原文依据」的推测答案固化下来误导后续用户。
- 与检索质量无关：缓存的是「已验证正确」的最终答案，不改变任何检索参数。
"""
from __future__ import annotations

import logging
import math
import re
import time

from app.agent import llm as llm_mod
from app.core.config import settings

log = logging.getLogger(__name__)

_CACHE: dict[str, dict] = {}
_MAX = 2000


def _norm(q: str) -> str:
    return re.sub(r"\s+", "", (q or "")).lower()[:200]


def _key(game_id: int | None, q: str) -> str:
    return f"{game_id if game_id is not None else 'x'}:{_norm(q)}"


def _cosine(a: list[float] | None, b: list[float] | None) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


async def get(game_id: int | None, q: str) -> dict | None:
    """命中返回 {text, level, model, hit, sim?}，未命中返回 None。"""
    if not settings.ANSWER_CACHE_ENABLED:
        return None
    k = _key(game_id, q)
    item = _CACHE.get(k)
    if item and time.time() - item["ts"] < settings.ANSWER_CACHE_TTL_SEC:
        return {**item, "hit": "exact"}

    # 近似命中：embedding 余弦 ≥ 阈值（仅同一游戏内比较，避免跨游戏串答案）
    if settings.ANSWER_CACHE_SIMILARITY > 0 and llm_mod.available():
        emb = await llm_mod.embed(q)
        if emb:
            best: dict | None = None
            bs = 0.0
            for it in _CACHE.values():
                if it.get("emb") and it.get("game_id") == game_id:
                    c = _cosine(emb, it["emb"])
                    if c > bs:
                        bs, best = c, it
            if best and bs >= settings.ANSWER_CACHE_SIMILARITY:
                return {**best, "hit": "similar", "sim": round(bs, 3)}
    return None


async def put(
    game_id: int | None,
    q: str,
    text: str,
    level: int,
    model: str | None,
    game_name: str | None = None,
) -> None:
    """写入缓存（仅命中明确层级时调用）。

    game_name 一并存下：命中缓存时要向前端回显「依据《X》的规则书」，
    只存 id 的话缓存分支只能给出 game=None（实测让 L6 别名用例误判为「没定位到游戏」）。
    """
    if not settings.ANSWER_CACHE_ENABLED or not text:
        return
    emb = None
    if settings.ANSWER_CACHE_SIMILARITY > 0 and llm_mod.available():
        emb = await llm_mod.embed(q)
    _CACHE[_key(game_id, q)] = {
        "text": text,
        "level": level,
        "model": model,
        "ts": time.time(),
        "emb": emb,
        "game_id": game_id,
        "game_name": game_name,
    }
    if len(_CACHE) > _MAX:
        oldest = min(_CACHE, key=lambda k: _CACHE[k]["ts"])
        _CACHE.pop(oldest)


def clear() -> None:
    _CACHE.clear()


def size() -> int:
    return len(_CACHE)
