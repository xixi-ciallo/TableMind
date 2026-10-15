"""桌游资料检索与 Prompt 上下文构造（RAG 的检索侧）。

检索分为两层：
- 结构化资料：board_games 的真实字段（人数 / 时长 / 分类 / 机制 / 简介等）。
- 规则说明书：rule_documents 向量切片（管理员上传的真实说明书）。命中某款游戏时，
  优先用该游戏的说明书片段（向量相似度 Top-K，embedding 不可用时降级关键词命中），
  让 AI 能回答具体规则细节，而非只给简介。两层都来自本站真实数据。
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
from collections import Counter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import llm
from app.core.config import settings
from app.models.board_game import BoardGame
from app.models.rule_document import RuleDocument

from . import tools

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是 TableMind（桌游信息库）的 AI 助手，专注于桌游规则讲解、玩法教学与选游戏推荐。

回答准则：
0. 【规则说明书】是权威来源：若资料里提供了某游戏的「规则说明书」片段，优先据此回答具体规则细节（回合流程、组件、拿取规则、计分、胜负条件等），可在相关结论后标注「依据规则说明书」；结构化资料仅作补充。
1. 只能依据「本站收录资料」中给出的事实作答。规则说明书与结构化资料都未覆盖的信息（价格、库存、评分人数等）必须如实说"本站暂无该信息"，绝对不要编造。
2. 推荐游戏时，从资料里挑选真正符合条件的，并说明推荐理由；如果资料里没有符合条件的，直说没有。
3. 讲解规则时，用清晰的分点说明；规则说明书与结构化资料都未覆盖的细节，要明确提示"该细节需参考说明书"。
4. 语言简洁友好，中文作答，避免空泛套话。
5. 不要暴露你的思维过程，只输出最终回答。
6. 输出格式：纯文本，不要使用任何 Markdown 语法（禁止 #、**、_、表格、代码块）。
   用空行分段，分点用「1. 2. 3.」或「- 」，强调只靠语气和小标题文字本身。

当前回答模式：{mode_desc}"""

MODE_DESC = {
    "fast": "快速模式——直接给结论，控制在 150 字以内，不超过 3 款推荐。",
    "deep": "深度模式——展开讲解，可对比分析，推荐 3-5 款并说明各自适用场景，可到 500 字。",
}


def _extract_players(message: str) -> int | None:
    """从提问里提取人数：4 人 / 四个人 / 双人 / 6人局。"""
    cn = {"两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8}
    m = re.search(r"(\d+)\s*(?:个)?人", message)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 12:
            return n
    m = re.search(r"([两二三四五六七八])\s*(?:个)?人", message)
    if m:
        return cn.get(m.group(1))
    for word, n in (("双人", 2), ("两人", 2), ("三人", 3), ("四人", 4), ("五人", 5), ("六人", 6)):
        if word in message:
            return n
    return None


# 时长方向词：「1 小时以上」「超过 90 分钟」说的是**下限**，不是上限。
_LOWER_BOUND_PAT = re.compile(r"以上|超过|至少|最少|多于|大于|不低于|更长|更久|以上")
_UPPER_BOUND_PAT = re.compile(r"以内|以下|不超过|最多|之内|小于|不到|左右|差不多")


def _extract_play_time_bounds(message: str) -> tuple[int | None, int | None]:
    """时长槽位 → (下限, 上限)，单位分钟。

    修复的真实缺陷：旧实现只返回「上限」，「想找一个能玩 1 小时以上的深度策略游戏」
    被抽成 60 分钟上限，于是把 30 分钟的轻量游戏推给了明确想要长局的人——方向反了。
    裸数字（「90 分钟」「30 分钟以内」）沿用旧口径按上限处理，保持既有行为不变。
    """
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:个)?小时", message)
    if m:
        minutes = int(float(m.group(1)) * 60)
        tail = message[m.end() : m.end() + 6]
        head = message[max(0, m.start() - 6) : m.start()]
    else:
        m = re.search(r"(\d+)\s*分钟", message)
        if m:
            minutes = int(m.group(1))
            tail = message[m.end() : m.end() + 6]
            head = message[max(0, m.start() - 6) : m.start()]
        else:
            minutes = None
            tail = ""
            head = ""
            for word, mins in (("半小时", 30), ("一小时", 60), ("两小时", 120), ("三小时", 180)):
                i = message.find(word)
                if i >= 0:
                    minutes = mins
                    tail = message[i + len(word) : i + len(word) + 6]
                    head = message[max(0, i - 6) : i]
                    break

    if minutes is None:
        return None, None
    # 方向词可能在数字前（「至少 2 小时」「超过 90 分钟」）也可能在后（「1 小时以上」）
    if _LOWER_BOUND_PAT.search(tail) or _LOWER_BOUND_PAT.search(head):
        return minutes, None
    # 上限方向词与「裸数字」都按上限处理（裸数字的旧行为就是上限，不能改）
    return None, minutes


def _extract_play_time(message: str) -> int | None:
    """从提问里提取时长**上限**（分钟）。方向词为上界时返回 None。"""
    return _extract_play_time_bounds(message)[1]


def _extract_min_play_time(message: str) -> int | None:
    """从提问里提取时长**下限**（分钟）：「1 小时以上」→ 60。"""
    return _extract_play_time_bounds(message)[0]


def _extract_complexity(message: str) -> float | None:
    """复杂度上限：新手/简单 → 轻策；硬核/重度 → 不限（交给模型说明）。"""
    if any(w in message for w in ("新手", "简单", "轻松", "入门", "轻策", "规则少", "容易上手")):
        return 2.5
    return None


async def retrieve(db: AsyncSession, message: str, limit: int = 8) -> tuple[list[dict], str]:
    """检索与提问相关的真实桌游资料。

    返回 (资料列表, 检索方式说明)，供上下文与降级文案使用。
    """
    # 1) 命中游戏名（含英文名）
    all_games = (await db.execute(select(BoardGame).order_by(BoardGame.id))).scalars().all()
    hits = [g for g in all_games if (g.name and g.name in message) or (g.name_en and g.name_en in message)]
    if hits:
        return [tools.brief(g) for g in hits[: max(1, limit)]], "game_name"

    # 2) 条件过滤（人数 / 时长 / 复杂度）
    players = _extract_players(message)
    play_time = _extract_play_time(message)
    play_time_min = _extract_min_play_time(message)
    complexity = _extract_complexity(message)
    if players or play_time or play_time_min or complexity:
        rows = await tools.search_games(
            db,
            min_players=players,
            max_players=players,
            play_time=play_time,
            play_time_min=play_time_min,
            complexity=complexity,
            limit=limit,
        )
        if rows:
            return rows, "filters"

    # 3) 关键词（分类 / 机制 / 出版商）模糊命中
    for kw in ("德式", "美式", "推理", "合作", "阵营", "策略", "卡牌", "聚会", "家庭", "儿童"):
        if kw in message:
            rows = await tools.search_games(db, category=kw, limit=limit)
            more = await tools.search_games(db, mechanic=kw, limit=limit)
            seen = {r["id"] for r in rows}
            rows += [r for r in more if r["id"] not in seen]
            if rows:
                return rows[:limit], "keyword"

    # 4) 兜底：站内真实收录
    return await tools.random_picks(db, limit=min(limit, 5)), "fallback"


def _cosine(a: list[float], b: list[float]) -> float:
    """余弦相似度（规则说明书切片规模很小，Python 内计算足够快）。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


_MIN_PREFIX = 4  # 公共前缀至少 4 个字才算命中，避免「玩家」「游戏」这类通用开头误匹配


def _common_prefix(a: str, b: str) -> str:
    """两个字符串的最长公共前缀。"""
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return a[:i]


def _norm_name(s: str) -> str:
    """归一化游戏名：去掉标点、空格与大小写差异。

    用于处理「工业革命伯明翰」与库名「工业革命：伯明翰」这类标点不一致的提问。
    """
    return re.sub(r"[\s:：·・\-—_,，、.。!！?？'\"“”‘’()（）\[\]【】]+", "", (s or "")).lower()


def _match_games(all_games: list[BoardGame], message: str) -> list[tuple[int, int, BoardGame]]:
    """对每款游戏取「最强的一次命中」，返回候选 [(命中长度, 方式优先级, 游戏)]，按强度降序。

    方式优先级：精确名=1 > 归一化名=0 > 公共前缀/主标题=-1 > 副标题简称=-2。
    同一款游戏命中多路时只保留最强的那一路——否则「七大奇迹」会被记两次，
    在 identify_games 里重复出现。
    """
    msg_norm = _norm_name(message)
    best: dict[int, tuple[int, int, BoardGame]] = {}

    def _record(g: BoardGame, score: int, prio: int) -> None:
        prev = best.get(g.id)
        if prev is None or (score, prio) > (prev[0], prev[1]):
            best[g.id] = (score, prio, g)

    for g in all_games:
        for cand in (g.name, g.name_en):
            if not cand:
                continue
            if cand in message:
                _record(g, len(cand), 1)
            norm = _norm_name(cand)
            if norm and norm in msg_norm:
                _record(g, len(norm), 0)
            # 公共前缀：解决「瘟疫危机传承」被主标题「瘟疫危机」截走的问题。
            # 多个游戏共享主标题时（瘟疫危机 / 瘟疫危机：传承），只比主标题长度分不出
            # 高下，会按 id 取小者而认错游戏；比「与提问的最长公共前缀」则自然是
            # 更完整的那个名字更长（传承=6 > 基础版=4）。
            prefix = len(_common_prefix(msg_norm, norm))
            if prefix >= _MIN_PREFIX:
                _record(g, prefix, -1)
            head = _norm_name(re.split(r"[:：]", cand)[0].strip())
            if len(head) >= 3 and head in msg_norm:
                _record(g, len(head), -1)
            # 副标题/简称匹配：玩家常用「阿瓦隆」「伯明翰」称呼《抵抗组织：阿瓦隆》
            # /《工业革命：伯明翰》。拆分主/副标题，任一子标题（归一化后 ≥3 字）
            # 出现在提问里即算候选；优先级最低（-2），完整名/归一化/主标题命中时不会被抢走。
            # 没有这一路，追问「阿瓦隆怎么玩」会因识别不到游戏而落到 L4「本站暂无该信息」。
            for part in re.split(r"[:：·・\-—–_]", cand):
                p = _norm_name(part)
                if len(p) >= 3 and p != norm and p != head and p in msg_norm:
                    _record(g, len(p), -2)

    return sorted(best.values(), key=lambda x: (-x[0], -x[1], x[2].id))


async def identify_game(db: AsyncSession, message: str) -> BoardGame | None:
    """识别提问命中的唯一桌游（最强命中）。

    四种匹配方式（精确名 / 归一化名 / 主标题 / 副标题简称）**统一按命中长度排序**，
    长度相同时 精确 > 归一化 > 主标题 > 简称。这样能同时解决四类真实提问：
    - 归一化：提问「工业革命伯明翰」命中库名「工业革命：伯明翰」；
    - 主标题：提问「历史巨轮」命中库名「历史巨轮：人类文明新篇章」；
    - 按长度排序：提问「七大奇迹对决」命中的是对决版，不会被短的「七大奇迹」抢先；
    - 副标题简称：提问「阿瓦隆怎么玩」命中《抵抗组织：阿瓦隆》。
    """
    cands = _match_games(
        (await db.execute(select(BoardGame).order_by(BoardGame.id))).scalars().all(), message
    )
    return cands[0][2] if cands else None


async def identify_games(db: AsyncSession, message: str) -> list[BoardGame]:
    """识别提问里提到的**全部**站内游戏，按命中强度降序。

    用于「阿瓦隆和狼人杀哪个更适合新手」这类**对比提问**：只取最强的一个会漏掉另一款，
    于是答案只讲一款、用户以为系统没认出另一款。

    注意：调用方应先用「确实在问某款/某几款游戏」的信号兜住，再调用本函数——
    短副标题（如「阿瓦隆」3 字）在通用句里也可能被误命中。
    """
    cands = _match_games(
        (await db.execute(select(BoardGame).order_by(BoardGame.id))).scalars().all(), message
    )
    return [g for _, _, g in cands]


async def retrieve_rule_chunks(db: AsyncSession, game_id: int, query: str, k: int = 5) -> list[str]:
    """检索某款游戏的【规则说明书】片段，按与提问的相关性排序（只要文本）。"""
    return [c for _idx, c in await retrieve_rule_chunk_hits(db, game_id, query, k)]


async def retrieve_rule_chunk_hits(
    db: AsyncSession, game_id: int, query: str, k: int = 5, expand: int = 0
) -> list[tuple[int, str]]:
    """同 retrieve_rule_chunks，但返回 (chunk_index, 原文)，并可选带回相邻切片。

    三段式检索，每一段都是被实测数据逼出来的（验证脚本 rag_layer2_retrieval.py）：

    1. **查询改写**：把口语化提问改写成规则书措辞（「硬币」→「钱币」、「暖到什么
       程度」→「温度达到多少」），多查询并行检索、每条切片取最高分。
    2. **混合召回**：向量语义 + BM25 字面（中文按二元组切词，无需分词器）。
       纯向量对「配件清单 / 准备物资的数字」类提问召回极差——答案原文里逐字存在，
       但整页切片语义被稀释，正确切片排名落到 4~18 位；BM25 能直接抓住稀有词。
    3. **归一化分数融合**（不是 RRF）：两路各自按自身最大值归一化到 [0,1] 后加权
       求和。RRF 只看排名、丢掉领先幅度，实测会让 BM25 的压倒性优势被向量路的
       低排名拖垮（瘟疫那题 BM25 第 1 却被融合到第 4）。

    实测 hit@3：纯向量基线 73.2% → 混合 + 改写后 90.9%。
    查询改写对「原题措辞」略有代价（100%→95.1%），但对「真实用户措辞」
    提升显著（57.1%→78.6%~85.7%），整体泛化更稳，故保留。

    expand=1 会把每条命中切片的「前后各一片」也纳入，再按原文序号排序输出。
    为什么需要：降级路径（大模型不可用，直接把规则原文端给用户）若只给高分切片，
    拿到的是碎片——「公，推翻统治。内奸：…」这种半截句读起来像乱码；
    带上前后文才读得成一段连续的规则。**只用于兜底展示，不参与检索排序**。
    """
    rows = (
        await db.execute(
            select(RuleDocument).where(RuleDocument.game_id == game_id).order_by(RuleDocument.chunk_index)
        )
    ).scalars().all()
    if not rows:
        return []

    docs = [r.content for r in rows]
    idx = [int(r.chunk_index) for r in rows]

    # ---- 查询改写：把口语化提问改写成规则书措辞，对抗同义改写 ----
    variants = [query]
    if QUERY_EXPAND_ENABLED and llm.available():
        variants += await _expand_queries(query)

    # ---- 第一路：向量语义召回（多个改写取每条切片的最高分）----
    vec_scores: list[float] | None = None
    embedded = [r for r in rows if r.embedding]
    if len(embedded) == len(rows):
        per_variant = []
        for q in variants:
            qvec = await llm.embed(q)
            if qvec:
                per_variant.append([_cosine(qvec, r.embedding) for r in rows])
        if per_variant:
            vec_scores = [max(s[i] for s in per_variant) for i in range(len(rows))]

    # ---- 第二路：BM25 字面召回（同样对多个改写取最高分）----
    bm_per_variant = [_bm25_scores(q, docs) for q in variants]
    bm_scores = [max(s[i] for s in bm_per_variant) for i in range(len(docs))]

    if vec_scores is None:
        # embedding 不可用：只用字面召回；一个查询词都没命中时退回关键词命中 / 顺序截取
        if max(bm_scores, default=0.0) <= 0:
            hit = [i for i, c in enumerate(docs) if any(w in c for w in _keywords(query))]
            order = hit or list(range(len(docs)))
        else:
            order = _rank_desc(bm_scores)
    else:
        order = _hybrid_order(vec_scores, bm_scores, _section_boost(docs, query))

    picked = order[:k]
    if expand > 0:
        keep: set[int] = set()
        for i in picked:
            keep.update(range(max(0, i - expand), min(len(docs), i + expand + 1)))
        picked = sorted(keep)
    return [(idx[i], docs[i]) for i in picked]


# ---- 混合检索的内部实现 ----

VECTOR_WEIGHT = 1.0      # 向量召回在融合中的权重
BM25_WEIGHT = 1.6        # 字面召回权重（规则问答里专有名词/数字多，实测高于向量效果更好）
FUSION = "score"         # "score"=归一化分数加权；"rrf"=排名倒数融合
_RRF_K = 60              # RRF 平滑常数，抑制头部排名的偶然性

_CJK = r"\u4e00-\u9fff"


QUERY_EXPAND_ENABLED = True     # 是否启用查询改写
QUERY_EXPAND_N = 2              # 额外生成几个改写查询
QUERY_EXPAND_MAX_TOKENS = 1200  # 该模型是推理模型，思维链会占用预算，给不足会得到空串
QUERY_EXPAND_TEMPERATURE = 0.2

_EXPAND_PROMPT = """把玩家对桌游规则的口语化提问，改写成 {n} 条「规则书里可能出现的措辞」的等价问句。

要求：
1. 只做同义改写，不改原意，不增删条件。
2. 把口语词换成规则书常用词（例：硬币→钱币、砖→磁砖、暖到什么程度→温度达到多少、开局→游戏准备、攒几分→获得多少胜利点）。
3. 每行一条，不要编号、不要解释、不要 Markdown。"""

_expand_cache: dict[str, list[str]] = {}
_EXPAND_CACHE_MAX = 500


async def _expand_queries(query: str) -> list[str]:
    """把口语化提问改写成若干规则书措辞的等价查询。

    为什么需要：实测「开局手上该有几块硬币？」检索不到写着「每位玩家从银行中拿取7元钱币」
    的切片——用户用词（硬币/开局）与规则书用词（钱币/游戏准备）不一致，向量和 BM25 都漏。
    多查询扩展后取每条切片的**最高分**，等价于「任意一种说法命中就算命中」。

    失败安全：任何异常都返回空列表，检索只用原查询，绝不影响主流程。
    """
    if not QUERY_EXPAND_ENABLED:
        return []
    cached = _expand_cache.get(query)
    if cached is not None:
        return cached

    # 失败不缓存：一次限流/网络抖动不应让该查询在进程生命周期内永远失去改写。
    # 加一次短重试，抗住连续调用后的瞬时 429。
    raw: str | None = None
    for attempt in (1, 2):
        try:
            raw = await llm.chat_complete(
                [
                    {"role": "system", "content": _EXPAND_PROMPT.format(n=QUERY_EXPAND_N)},
                    {"role": "user", "content": query},
                ],
                temperature=QUERY_EXPAND_TEMPERATURE,
                max_tokens=QUERY_EXPAND_MAX_TOKENS,
                model=settings.LLM_RULE_MODEL or settings.LLM_MODEL,
                enable_thinking=False,
            )
            break
        except Exception as e:  # noqa: BLE001
            log.debug("查询改写失败（第 %s 次），改用原查询：%s", attempt, e)
            if attempt == 2:
                return []
            await asyncio.sleep(0.8)

    out: list[str] = []
    for line in (raw or "").splitlines():
        s = re.sub(r"^\s*[\-\d\.、）)]+\s*", "", line).strip()
        s = re.sub(r"\s+", " ", s)
        if len(s) >= 4 and s != query and s not in out:
            out.append(s)
        if len(out) >= QUERY_EXPAND_N:
            break

    if not out:
        return []  # 空结果同样不缓存，下次请求重试
    if len(_expand_cache) >= _EXPAND_CACHE_MAX:
        _expand_cache.clear()
    _expand_cache[query] = out
    return out


def _tokenize(text: str) -> list[str]:
    """中英文混合分词：中文按 **二元组**（无需第三方分词器），英文/数字按词。

    中文用二元组是因为没有 jieba 依赖时，它是 CJK 检索的标准做法：
    「玩家卡牌」→「玩家 / 家卡 / 卡牌」，既能匹配也能抗一点语序变化。
    """
    s = (text or "").lower()
    toks: list[str] = []
    for run in re.findall(rf"[{_CJK}]+|[a-z0-9]+", s):
        if run[0] >= "\u4e00":
            if len(run) == 1:
                toks.append(run)
            else:
                toks.extend(run[i:i + 2] for i in range(len(run) - 1))
        else:
            toks.append(run)
    return toks


def _bm25_scores(query: str, docs: list[str], k1: float = 1.5, b: float = 0.75) -> list[float]:
    """对 docs 逐条算 BM25 分数（下标对齐 docs）。

    返回原始分数而非排名，便于调用方判断「是否一个查询词都没命中」。
    """
    qtok = set(_tokenize(query))
    if not qtok:
        return [0.0] * len(docs)

    dtok = [_tokenize(d) for d in docs]
    tfs = [Counter(d) for d in dtok]
    n = len(docs)
    avgdl = sum(len(d) for d in dtok) / max(n, 1)
    df = {t: sum(1 for tf in tfs if tf.get(t)) for t in qtok}

    out: list[float] = []
    for i, tf in enumerate(tfs):
        dl = len(dtok[i])
        s = 0.0
        for t in qtok:
            f = tf.get(t, 0)
            if not f:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / max(avgdl, 1e-9)))
        out.append(s)
    return out


def _rank_desc(scores: list[float]) -> list[int]:
    """按分数降序返回下标；分数相同时按原顺序，保证结果稳定可复现。"""
    return [i for i, _ in sorted(enumerate(scores), key=lambda x: (-x[1], x[0]))]


def _rrf(rank_lists: list[list[int]], weights: list[float]) -> list[int]:
    """Reciprocal Rank Fusion：把多路排名融合成一路（只用排名，不看分数差距）。"""
    fused: dict[int, float] = {}
    for ranks, w in zip(rank_lists, weights):
        for rank, idx in enumerate(ranks):
            fused[idx] = fused.get(idx, 0.0) + w / (_RRF_K + rank + 1)
    return sorted(fused, key=lambda i: (-fused[i], i))


def _normalize(scores: list[float]) -> list[float]:
    """按该路自身的最大值归一化到 [0,1]，消除量纲差异（余弦 0.1~0.6 vs BM25 0~20）。

    只除最大值而不是 min-max 拉伸：min-max 会把「整路分数几乎持平」的噪声放大成
    满量程差异，反而压过真正有区分度的一路。
    """
    mx = max(scores, default=0.0)
    if mx <= 0:
        return [0.0] * len(scores)
    return [s / mx for s in scores]


# 章节感知加权幅度。由 .workbuddy/tmp/rag_layer2_tune.py 离线扫参确定：
# 0.4~3.5 均有正向收益，1.8~3.5 是平台期（原题 41/41 + 改写 13/14 = 98.2%），
# 取 2.5 是因为它在 BM25_WEIGHT=1.6 与 2.0 两个权重下都稳，不是踩在临界值上。
SECTION_BOOST = 2.5

# 提问意图：数量型（问「有多少/几个」）与准备型（问「开局/初始」）
_INTENT_QUANT = re.compile(r"多少|几张|几个|几块|几枚|几名|几|一共|总共|总数|数量|总计")
_INTENT_SETUP = re.compile(r"开局|初始|起始|准备|设置|开始|起手|游戏前")
# 切片类型：配件清单页 / 准备设置页（只看前 80 字，避免正文里顺带提到）
_SEC_COMPONENT = re.compile(r"配件|内容物")
_SEC_SETUP = re.compile(r"游戏准备|准备|设置")


def _section_boost(docs: list[str], query: str) -> list[float]:
    """章节感知加权：问「有多少 / 开局怎样」时，给配件清单、游戏准备类切片加权。

    实测依据：改写组未命中的 5 题里有 4 题，答案都躺在「配件 / 设置」页上——
    这类页面整页都是罗列，语义上跟任何问题都沾一点边、又都不够像，
    纯向量和 BM25 都排不到前面（方舟动物园那题正确切片排到第 29 位）。
    而「问数量、问开局」恰恰是这类页面最常被问到的场景，故按意图加权。

    只影响排序权重，不改变召回集合，也不会凭空造内容。
    """
    if SECTION_BOOST <= 0:
        return [1.0] * len(docs)
    want_quant = bool(_INTENT_QUANT.search(query))
    want_setup = bool(_INTENT_SETUP.search(query))
    if not (want_quant or want_setup):
        return [1.0] * len(docs)

    out: list[float] = []
    for d in docs:
        head = re.sub(r"\s+", "", d)[:80]
        m = 1.0
        if want_quant and _SEC_COMPONENT.search(head):
            m += SECTION_BOOST
        if want_setup and _SEC_SETUP.search(head):
            m += SECTION_BOOST
        out.append(m)
    return out


def _hybrid_order(
    vec_scores: list[float],
    bm_scores: list[float],
    boost: list[float] | None = None,
) -> list[int]:
    """把向量路与 BM25 路融合成最终排序（纯函数，便于离线调参与回归测试）。

    默认用 **归一化分数加权**（FUSION="score"）。为什么不用纯 RRF：RRF 只看排名、
    丢掉了「领先多少」这个置信度。实测「初始配件里有多少张玩家卡牌」这道题，
    BM25 给正确切片 16.1 分、第二名只有 5.81（绝对优势），但向量路把它排到 18 名，
    RRF 一融合就被拖到第 4 名而漏召；改成分数融合后正确切片回到第 1。
    """
    if FUSION == "rrf":
        return _rrf([_rank_desc(vec_scores), _rank_desc(bm_scores)],
                    [VECTOR_WEIGHT, BM25_WEIGHT])

    v = _normalize(vec_scores)
    b = _normalize(bm_scores)
    total = [VECTOR_WEIGHT * a + BM25_WEIGHT * c for a, c in zip(v, b)]
    if boost:
        total = [t * m for t, m in zip(total, boost)]
    return _rank_desc(total)


def _keywords(text: str) -> list[str]:
    """从提问里提取用于关键词检索的中文/英文连续词（长度 >= 2）。"""
    words = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z]{2,}", text)
    # 去掉常见无意义的泛化词
    stop = {"怎么", "什么", "规则", "玩法", "如何", "可以", "请问", "多少", "适合"}
    return [w for w in set(words) if w not in stop]


def format_context(games: list[dict]) -> str:
    """把检索结果整理成给模型的上下文（每行一款，字段名对人可读）。"""
    if not games:
        return "（本站暂无相关收录资料）"

    lines: list[str] = []
    for i, g in enumerate(games, 1):
        bits: list[str] = [f"【{i}】《{g['name']}》"]
        if g.get("name_en"):
            bits.append(f"英文名 {g['name_en']}")
        if g.get("players"):
            bits.append(f"{g['players']} 人")
        if g.get("play_time"):
            bits.append(f"单局约 {g['play_time']} 分钟")
        if g.get("min_age"):
            bits.append(f"适龄 {g['min_age']}+")
        if g.get("complexity"):
            bits.append(f"复杂度 {g['complexity']}/5")
        if g.get("year"):
            bits.append(f"{g['year']} 年")
        if g.get("publisher"):
            bits.append(f"出版 {g['publisher']}")
        if g.get("categories"):
            bits.append("分类：" + "、".join(g["categories"][:5]))
        if g.get("mechanics"):
            bits.append("机制：" + "、".join(g["mechanics"][:5]))
        if g.get("description"):
            bits.append(f"简介：{g['description']}")
        lines.append(" / ".join(bits))
    return "\n".join(lines)


async def build_messages(
    db: AsyncSession,
    message: str,
    mode: str = "fast",
    history: list[tuple[str, str]] | None = None,
    user_id: int | None = None,
    game_id: int | None = None,
) -> list[dict]:
    """组装发给大模型的完整消息列表。

    game_id 由调用方显式指定时（例如从游戏详情页发起的规则问答）优先使用，
    避免只靠提问文本识别导致明明指定了游戏却检索不到说明书。
    """
    games, _how = await retrieve(db, message)

    system = SYSTEM_PROMPT.format(mode_desc=MODE_DESC.get(mode, MODE_DESC["fast"]))

    context_parts: list[str] = []

    # 命中具体游戏时，优先给出该游戏的【规则说明书】片段（提升具体规则细节质量）
    game: BoardGame | None = None
    if game_id is not None:
        game = await db.get(BoardGame, game_id)
    if game is None:
        game = await identify_game(db, message)
    rule_chunks: list[str] = []
    if game:
        rule_chunks = await retrieve_rule_chunks(db, game.id, message)
    if rule_chunks:
        header = (
            f"《{game.name}》的【规则说明书】片段（来自本站上传的真实说明书，"
            f"按与提问的相关度排序，共 {len(rule_chunks)} 段）："
        )
        context_parts.append(header + "\n\n" + "\n\n".join(
            f"片段{i + 1}：{c}" for i, c in enumerate(rule_chunks)
        ))

    # 结构化收录资料（始终附上，作为补充与兜底）
    if games:
        context_parts.append(
            f"本站结构化收录资料（共 {len(games)} 条，均为真实数据）：\n{format_context(games)}"
        )
    else:
        context_parts.append("（本站暂无相关结构化收录资料）")

    if user_id is not None:
        try:
            collection = await tools.get_user_collection(db, user_id)
        except Exception:
            collection = []
        if collection:
            listed = "、".join(f"《{c['name']}》({c['status']})" for c in collection[:20])
            context_parts.append(f"该用户已收藏：{listed}。推荐时尽量避免重复，或说明为何仍值得推荐。")

    messages: list[dict] = [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n\n".join(context_parts)},
        {"role": "assistant", "content": "好的，我已阅读本站收录资料，会严格依据这些真实数据回答。"},
    ]

    if history:
        for role, content in history[-10:]:  # 只带最近 10 条，控制 prompt 长度
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": message})
    return messages
