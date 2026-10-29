"""站内候选池（candidate pool）——推荐与规则问答共用的**唯一真相**。

为什么要单独立一个模块：真实缺陷（用户截图）——同一款游戏，上一轮还能推荐，
下一轮问它却答「候选未收录阿瓦隆」。根因**不是数据缺失**（《抵抗组织：阿瓦隆》
就在库内，id=18，还有 8 块规则切片），而是「候选池」没有单一出处：
推荐走的是「按本次条件硬过滤后的结果集」，提示词却要求模型「只能从候选游戏里挑」，
于是模型把「不在本次筛选结果里」误报成了「本站未收录」。本模块把口径写死：

候选池定义（唯一）：
    池 = board_games 表里的全部收录记录（当前 47 款）。
    「本次筛选结果」只是从池里按人数/时长/类型条件挑出的子集，
    **不改变池本身**——所以两次问「6 人推荐」得到的是同一个池、同一套排序，
    不会再出现「这次有阿瓦隆、下次没有」。

池与规则库的对齐（实测）：47/47 款都有 rule_documents 切片，
所以推荐过的任何一款都能立刻追问规则，不会「刚推荐就说不认识」。
若将来有游戏入库但未传规则书，has_rules=False，推荐时如实标注「⚠ 暂无规则书」。
"""
from __future__ import annotations

import logging
import re
import time

from sqlalchemy import func, select

from app.agent import tools as db_tools
from app.models.board_game import BoardGame
from app.models.rule_document import RuleDocument

log = logging.getLogger(__name__)

# 给用户看的规则可用性标记（推荐结果逐款标注，避免「刚推荐就说不认识」的落差）
RULE_MARK_YES = "✓ 可查规则"
RULE_MARK_NO = "⚠ 暂无规则书"


def mark_for(chunks: int) -> str:
    """按规则切片数给出标记文案。"""
    return RULE_MARK_YES if chunks > 0 else RULE_MARK_NO


_rules_coverage_cache: dict = {'at': 0.0, 'cov': None}
_RULE_COVERAGE_TTL_SEC = 120.0

async def rules_coverage(db) -> dict[int, int]:
    """game_id → 规则切片数（全表一次分组查询，47 行，开销极小）。

    结果近乎静态（规则切片不常变），进程内缓存 2 分钟，避免单次推荐请求里
    pool_stats / load_pool / game_focus_stream 各查一次。
    """
    now = time.monotonic()
    if _rules_coverage_cache['cov'] is not None and now - _rules_coverage_cache['at'] < _RULE_COVERAGE_TTL_SEC:
        return _rules_coverage_cache['cov']
    rows = (
        await db.execute(
            select(RuleDocument.game_id, func.count(RuleDocument.id)).group_by(
                RuleDocument.game_id
            )
        )
    ).all()
    cov = {int(gid): int(n) for gid, n in rows}
    _rules_coverage_cache.update({'at': now, 'cov': cov})
    return cov


async def pool_stats(db) -> dict:
    """池规模：总数 / 有规则书数 / 无规则书数。"""
    total = int(await db.scalar(select(func.count(BoardGame.id))) or 0)
    with_rules = len(await rules_coverage(db))
    return {
        "total": total,
        "with_rules": with_rules,
        "without_rules": max(0, total - with_rules),
    }


async def pool_roster(db) -> list[str]:
    """池内全部游戏名（按收录顺序）。"""
    rows = (await db.execute(select(BoardGame.name).order_by(BoardGame.id))).all()
    return [n for (n,) in rows if n]


async def pool_roster_text(db, limit: int = 60) -> str:
    """池内全部游戏名拼成一行，供提示词使用——模型据此判断「这款在不在池里」。

    之前提示词只给「本次筛选出的 6 款」，模型于是把池内但未入选的阿瓦隆
    当成「本站未收录」。给出完整池名单后，这一类误报从根上消失。
    """
    names = await pool_roster(db)
    shown = names[:limit]
    tail = f"…等共 {len(names)} 款" if len(names) > limit else f"共 {len(names)} 款"
    return "、".join(shown) + f"（{tail}）"


async def load_pool(
    db,
    *,
    players: int | None = None,
    play_time_max: int | None = None,
    play_time_min: int | None = None,
    keyword: str | None = None,
    complexity_max: float | None = None,
    limit: int = 12,
) -> list[dict]:
    """从**唯一的候选池**里按条件筛出一批，并逐条补上规则可用性。

    关键词可能只命中分类/机制（而非游戏名），此时各试一次再合并——与改造前一致。
    时长分上下限：「1 小时以上」必须走 play_time_min，否则方向反了。
    """
    rows = await db_tools.search_games(
        db,
        keywords=keyword,
        min_players=players,
        max_players=players,
        play_time=play_time_max,
        play_time_min=play_time_min,
        complexity=complexity_max,
        limit=limit,
    )
    if not rows and keyword:
        # 关键词可能只命中分类/机制（而非游戏名），此时各试一次再合并——与改造前一致。
        # 注意：**必须带上其余全部条件**。真实缺陷（2026-10-14 实测）：这里原来只传 keyword，
        # 于是「1 小时以上的策略游戏」经此兜底后时长条件被静默丢弃，20 分钟的小品游戏
        # 被当成「1 小时以上」推荐给了用户。
        common: dict = {
            "min_players": players,
            "max_players": players,
            "play_time": play_time_max,
            "play_time_min": play_time_min,
            "complexity": complexity_max,
            "limit": limit,
        }
        rows = await db_tools.search_games(db, category=keyword, **common)
        more = await db_tools.search_games(db, mechanic=keyword, **common)
        seen = {r["id"] for r in rows}
        rows += [r for r in more if r["id"] not in seen]

    cov = await rules_coverage(db)
    for r in rows:
        n = int(cov.get(int(r["id"]), 0))
        r["rule_chunks"] = n
        r["has_rules"] = n > 0
        r["rule_mark"] = mark_for(n)
    return rows


def slot_desc(
    players: int | None,
    play_time_max: int | None,
    keyword: str | None,
    play_time_min: int | None = None,
) -> str:
    """把本次筛选条件说成人话，用于「不在本次推荐中」的解释。"""
    bits: list[str] = []
    if players:
        bits.append(f"{players} 人可玩")
    if play_time_min:
        bits.append(f"{play_time_min} 分钟以上")
    if play_time_max:
        bits.append(f"{play_time_max} 分钟以内")
    if keyword:
        bits.append(f"类型/机制含「{keyword}」")
    return "、".join(bits) if bits else "全部条件"


# ---- keyword 校验：LLM 抽出的关键词必须真的能用于检索 ----
#
# 真实缺陷（2026-10-14 用户截图）：LLM 结构化路由把「两人玩」「怎么样」这类
# **非类型词**当成 keyword 填进槽位，直接进候选池过滤 →
# `name ilike '%两人玩%'` 命中 0 条 → 助手回答「本站暂无符合条件的桌游」，
# 而库里明明有 47 款、其中 2 人可玩的有 29 款。keyword 必须能对上站内真实词表，
# 否则一律丢弃——丢一个关键词最多让筛选变宽，绝不至于把结果清空。

_vocab_cache: dict = {"at": 0.0, "vocab": frozenset()}
_VOCAB_TTL_SEC = 600.0
# 关键词里不允许出现的字符（标点/空白说明它不是「类型词」而是半句话）
_KW_BAD_CHARS = re.compile(r"[，。？！、；：,?!;:\s]")


async def _retrieval_vocab(db) -> frozenset[str]:
    """站内真实存在的检索词表：分类 + 机制 + 游戏名（中/英），进程内缓存 10 分钟。

    47 行一次查询，开销可忽略；缓存是为了避免每次推荐都重扫一遍全表。
    """
    now = time.monotonic()
    if _vocab_cache["vocab"] and now - _vocab_cache["at"] < _VOCAB_TTL_SEC:
        return _vocab_cache["vocab"]

    vocab: set[str] = set()
    rows = (
        await db.execute(
            select(
                BoardGame.categories, BoardGame.mechanics, BoardGame.name, BoardGame.name_en
            )
        )
    ).all()
    for cats, mechs, name, name_en in rows:
        for bucket in (cats, mechs):
            if isinstance(bucket, list):
                for v in bucket:
                    if v:
                        vocab.add(str(v).strip().lower())
        for v in (name, name_en):
            if v:
                vocab.add(str(v).strip().lower())
    frozen = frozenset(vocab)
    _vocab_cache.update({"at": now, "vocab": frozen})
    return frozen


async def sanitize_keyword(db, keyword: str | None) -> str | None:
    """校验 keyword 是否真的能当检索条件用，不能则丢弃（返回 None）。

    保留条件（满足任一）：完全等于某站内词；是某站内词的子串（「卡牌」⊂「卡牌抽取」）；
    或长度 ≤ 4 且包含某个站内词（「合作类」含「合作」）。

    命中第三类时必须**返回站内原词**而不是用户原话：词表里是 categories/mechanics 的
    子串匹配，「合作类」直接去 ilike 匹配不到「合作」，等于条件被静默丢掉。
    """
    if not keyword:
        return None
    kw = str(keyword).strip()
    if not kw or len(kw) > 8 or _KW_BAD_CHARS.search(kw):
        return None

    low = kw.lower()
    for v in await _retrieval_vocab(db):
        if not v:
            continue
        if low == v or low in v:
            return kw
        if len(low) <= 4 and v in low:
            return v

    log.info("丢弃无法用于检索的 keyword：'%s'（站内词表无对应）", kw)
    return None


async def load_pool_relaxed(
    db,
    *,
    players: int | None = None,
    play_time_max: int | None = None,
    play_time_min: int | None = None,
    keyword: str | None = None,
    complexity_max: float | None = None,
    limit: int = 12,
) -> tuple[list[dict], str]:
    """带「逐级放宽」的候选查询，返回 (候选, 放宽说明；未放宽时为空串)。

    为什么需要：候选池有 47 款，任何一次「0 条」都极可能是**条件互相打架**
    （一个不可检索的关键词、或人数与时长的组合太窄），而不是站里真没有。
    宁可在放宽后的池里挑并如实说明放宽了什么，也不要甩一句「本站暂无符合条件的桌游」。

    放宽顺序（每次只丢一个最不影响语义的条件）：
        原条件 → 丢 keyword → 丢时长下限 → 丢全部时长 → 再丢人数 → 全部
    """
    base: dict = {
        "players": players,
        "play_time_max": play_time_max,
        "play_time_min": play_time_min,
        "keyword": keyword,
        "complexity_max": complexity_max,
        "limit": limit,
    }
    steps: list[tuple[dict, str]] = [(base, "")]
    if keyword:
        steps.append(({**base, "keyword": None}, "已忽略类型关键词"))
    if play_time_min:
        steps.append(
            ({**base, "keyword": None, "play_time_min": None}, "已忽略类型关键词与时长下限")
        )
    if play_time_max or play_time_min:
        steps.append(
            (
                {**base, "keyword": None, "play_time_max": None, "play_time_min": None},
                "已忽略类型关键词与时长条件",
            )
        )
    if players:
        steps.append(
            (
                {
                    **base,
                    "keyword": None,
                    "play_time_max": None,
                    "play_time_min": None,
                    "players": None,
                },
                "已放宽全部条件，按站内收录顺序推荐",
            )
        )

    seen: set = set()
    for kwargs, note in steps:
        sig = tuple(sorted((k, v) for k, v in kwargs.items() if k != "limit"))
        if sig in seen:
            continue
        seen.add(sig)
        rows = await load_pool(db, **kwargs)
        if rows:
            return rows, note
    return [], "站内暂无可推荐记录"


def out_of_scope_text(name: str, stats: dict) -> str:
    """池外游戏的统一解释口径（规则问答与推荐两条链路都用它，说法一致）。"""
    return (
        f"《{name}》不在本站候选池里，暂时无法评价它。\n"
        f"本站候选池 = 已收录资料的 {stats['total']} 款桌游"
        f"（其中 {stats['with_rules']} 款已录入规则说明书），推荐与规则问答都只在这个范围内作答。\n"
        "需要的话，把它加进本站收录后我就能答它的规则与资料。"
    )


def in_pool_but_not_picked_text(game_name: str, players_slots: str) -> str:
    """池内、但不在本次筛选结果里的解释（避免被误读成「本站没有」）。"""
    return (
        f"说明：这次是按「{players_slots}」筛的，所以《{game_name}》不在本次推荐列表里；"
        f"但它在本站候选池内，下面按站内已收录的资料说它。"
    )
