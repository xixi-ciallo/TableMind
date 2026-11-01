"""热点规则问答答案缓存。

目标：高频或近似重复的规则问题直接返回已生成的答案，首字延迟≈0，绕开
「改写 LLM + 生成 LLM（推理模型思维链）」这一长链路。

设计要点：
- key = 游戏 id + 归一化问题；近似命中用 embedding 余弦 ≥ ANSWER_CACHE_SIMILARITY。
- 双层结构（ANSWER_CACHE_BACKEND="redis"，默认）：进程内存作热层（近似命中需要
  扫描 embedding，内存最快），Redis 作持久层——重启不丢、多 worker 共享。
  Redis 不可用时自动回落纯内存（best-effort，绝不影响问答主流程）。
- 本地 Redis 为 5.0 Windows 版（仅 RESP2、无哈希字段 TTL），因此每条目用独立
  字符串键（SET EX 自带 TTL）+ 每游戏一个 SET 索引（SMEMBERS 后 MGET 批量取）。
- 只缓存依据明确的层级（L1 结构化 / L2 规则书 / L3 BGG），绝不缓存 L4（未验证），
  避免把「本站无原文依据」的推测答案固化下来误导后续用户。
- 与检索质量无关：缓存的是「已验证正确」的最终答案，不改变任何检索参数。
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import time

from app.agent import llm as llm_mod
from app.core.config import settings

log = logging.getLogger(__name__)

_CACHE: dict[str, dict] = {}
_MAX = 2000
_PREFIX = "tm:ansc"

# 惰性单例：首次使用才建连接；连接失败则本进程禁用 Redis（只告警一次）
_redis = None
_redis_dead = False


def _norm(q: str) -> str:
    return re.sub(r"\s+", "", (q or "")).lower()[:200]


def _chars(q: str) -> set[str]:
    return set(_norm(q))


def _overlap(a: str, b: str) -> float:
    """字符集合 Jaccard：挡住「同一游戏、但问的是另一个东西」的近似命中。

    实测「三国杀中装备牌有哪些」的缓存会把「防具里面不是还有个藤甲吗」判成近似问题
    （embedding 余弦 ≥ 0.93），导致追问拿到上一轮的旧答案。
    """
    sa, sb = _chars(a), _chars(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _hkey(game_id: int | None, q: str) -> str:
    """Redis 键里的短哈希：归一化问题可能含任意字符/超长，哈希后键名安全且定长。"""
    return hashlib.sha1(_norm(q).encode("utf-8")).hexdigest()[:16]


def _mem_key(game_id: int | None, q: str) -> str:
    return f"{game_id if game_id is not None else 'x'}:{_norm(q)}"


def _r_entry_key(game_id: int | None, q: str) -> str:
    return f"{_PREFIX}:e:{game_id if game_id is not None else 'x'}:{_hkey(game_id, q)}"


def _r_idx_key(game_id: int | None) -> str:
    return f"{_PREFIX}:idx:{game_id if game_id is not None else 'x'}"


def _cosine(a: list[float] | None, b: list[float] | None) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


async def _get_redis():
    """返回可用的 Redis 客户端；不可用返回 None（进程内只告警一次）。

    本地 Redis 5.0 仅支持 RESP2，redis-py 8.x 默认 RESP3（发 HELLO 会报
    unknown command），必须显式 protocol=2。
    """
    global _redis, _redis_dead
    if settings.ANSWER_CACHE_BACKEND != "redis" or _redis_dead:
        return None
    if _redis is not None:
        return _redis
    try:
        import redis.asyncio as aioredis

        client = aioredis.from_url(
            settings.REDIS_URL, socket_timeout=1.5, protocol=2, decode_responses=True
        )
        await client.ping()
        _redis = client
        log.info("answer cache: Redis 持久层已连接 %s", settings.REDIS_URL)
        return _redis
    except Exception as e:  # noqa: BLE001 —— best-effort，连不上就用内存
        _redis_dead = True
        log.warning("answer cache: Redis 不可用（%s），回落进程内存缓存", e)
        return None


def _to_json(item: dict) -> str:
    return json.dumps(item, ensure_ascii=False)


def _from_json(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001 —— 坏数据当未命中
        return None


async def _remember(item: dict) -> None:
    """写入内存热层；Redis 可用时同步写持久层。"""
    k = _mem_key(item.get("game_id"), item.get("q") or "")
    _CACHE[k] = item
    if len(_CACHE) > _MAX:
        oldest = min(_CACHE, key=lambda k2: _CACHE[k2]["ts"])
        _CACHE.pop(oldest)

    r = await _get_redis()
    if r is None:
        return
    gid = item.get("game_id")
    ttl = settings.ANSWER_CACHE_TTL_SEC
    try:
        await r.set(_r_entry_key(gid, item.get("q") or ""), _to_json(item), ex=ttl)
        await r.sadd(_r_idx_key(gid), _hkey(gid, item.get("q") or ""))
        await r.expire(_r_idx_key(gid), ttl)  # 索引随最近一次写入续期
    except Exception as e:  # noqa: BLE001
        log.warning("answer cache: Redis 写入失败（%s），仅保留内存", e)


async def _find_in_redis(game_id: int | None, q: str, emb: list[float] | None) -> dict | None:
    """持久层查找：先精确命中，再做与内存版一致的近似命中（余弦 + Jaccard 兜底）。"""
    r = await _get_redis()
    if r is None:
        return None
    try:
        raw = await r.get(_r_entry_key(game_id, q))
        item = _from_json(raw)
        if item:
            return item

        if emb and settings.ANSWER_CACHE_SIMILARITY > 0:
            idx = await r.smembers(_r_idx_key(game_id))
            if idx:
                keys = [f"{_PREFIX}:e:{game_id if game_id is not None else 'x'}:{h}" for h in idx]
                rows = await r.mget(keys)
                best: dict | None = None
                bs = 0.0
                for it in (_from_json(x) for x in rows):
                    if not it or not it.get("emb") or it.get("game_id") != game_id:
                        continue
                    c = _cosine(emb, it["emb"])
                    if c > bs:
                        bs, best = c, it
                if best and bs >= settings.ANSWER_CACHE_SIMILARITY:
                    cached_q = best.get("q") or ""
                    if cached_q and _overlap(q, cached_q) < 0.6:
                        return None
                    return best
    except Exception as e:  # noqa: BLE001
        log.warning("answer cache: Redis 读取失败（%s），按未命中处理", e)
    return None


async def get(game_id: int | None, q: str) -> dict | None:
    """命中返回 {text, level, model, hit, sim?}，未命中返回 None。"""
    if not settings.ANSWER_CACHE_ENABLED:
        return None
    k = _mem_key(game_id, q)
    item = _CACHE.get(k)
    if item and time.time() - item["ts"] < settings.ANSWER_CACHE_TTL_SEC:
        return {**item, "hit": "exact"}

    # 近似命中：embedding 余弦 ≥ 阈值（仅同一游戏内比较，避免跨游戏串答案）。
    # embedding 只算一次，内存与 Redis 两条近似路径共用。
    emb: list[float] | None = None
    if settings.ANSWER_CACHE_SIMILARITY > 0 and llm_mod.available():
        emb = await llm_mod.embed(q)

    # 内存近似命中
    if emb:
        best: dict | None = None
        bs = 0.0
        for it in _CACHE.values():
            if it.get("emb") and it.get("game_id") == game_id:
                c = _cosine(emb, it["emb"])
                if c > bs:
                    bs, best = c, it
        if best and bs >= settings.ANSWER_CACHE_SIMILARITY:
            cached_q = best.get("q") or ""
            # 余弦高不代表问的是同一件事（同款游戏的问题天然接近），再用字符
            # 集合重合度兜一层：低于 0.6 视为不同问题，宁可重新生成。
            if cached_q and _overlap(q, cached_q) < 0.6:
                return None
            return {**best, "hit": "similar", "sim": round(bs, 3)}

    # 内存未命中 → Redis 持久层（精确 + 近似）；命中回填内存热层
    r_item = await _find_in_redis(game_id, q, emb)
    if r_item:
        r_item["ts"] = r_item.get("ts") or time.time()
        await _remember(r_item)
        sim = _cosine(emb, r_item.get("emb")) if emb else None
        if sim is not None and sim < 1.0:
            return {**r_item, "hit": "similar", "sim": round(sim, 3)}
        return {**r_item, "hit": "exact"}
    return None


async def put(
    game_id: int | None,
    q: str,
    text: str,
    level: int,
    model: str | None,
    game_name: str | None = None,
    citations: list[dict] | None = None,
) -> None:
    """写入缓存（仅命中明确层级时调用）。

    game_name 一并存下：命中缓存时要向前端回显「依据《X》的规则书」，
    只存 id 的话缓存分支只能给出 game=None（实测让 L6 别名用例误判为「没定位到游戏」）。
    citations 也一并存下：缓存命中时仍要能展示引用溯源，否则同样的问题第二次问就没有来源了。
    """
    if not settings.ANSWER_CACHE_ENABLED or not text:
        return
    emb = None
    if settings.ANSWER_CACHE_SIMILARITY > 0 and llm_mod.available():
        emb = await llm_mod.embed(q)
    item = {
        "text": text,
        "level": level,
        "model": model,
        "ts": time.time(),
        "emb": emb,
        "q": _norm(q),
        "game_id": game_id,
        "game_name": game_name,
        "citations": citations or [],
    }
    await _remember(item)


def clear() -> None:
    """清空内存热层，并 best-effort 清掉 Redis 里本服务的全部键。"""
    _CACHE.clear()
    try:
        import asyncio

        from app.core.config import settings as _s

        if _s.ANSWER_CACHE_BACKEND != "redis":
            return
        loop = asyncio.get_running_loop()
        loop.create_task(_clear_redis())
    except RuntimeError:
        pass  # 无事件循环（如脚本里同步调用），只清内存


async def _clear_redis() -> None:
    r = await _get_redis()
    if r is None:
        return
    try:
        removed = 0
        async for key in r.scan_iter(match=f"{_PREFIX}:*", count=200):
            await r.delete(key)
            removed += 1
        if removed:
            log.info("answer cache: 已清理 Redis 持久层 %s 条", removed)
    except Exception as e:  # noqa: BLE001
        log.warning("answer cache: Redis 清理失败（%s）", e)


def size() -> int:
    return len(_CACHE)
