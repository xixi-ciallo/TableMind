"""桌游推荐流水线：候选池筛选 → 内容过滤 → 协同过滤（数据不足则降级）→ LLM 生成理由。

诚实说明「混合推荐」在当前数据下的真实状态：
- **内容过滤（可做功）**：categories / mechanics 覆盖 50/50，是当下真正的排序依据。
- **协同过滤（当前做不了）**：`reviews` 表实测 0 行（演示数据已按用户要求清空），
  用户-物品矩阵为空，任何 CF 结果都是编的。故本模块**先算出有没有足够数据**，
  不足就返回 None 并在回答里如实标注「暂未启用协同过滤（评分数据不足）」，
  绝不假装做了 CF。等真实评分积累到 MIN_RATINGS_FOR_CF 条会自动生效。
- **复杂度维度（当前缺失）**：board_games.complexity 实测 0/50 全 null，
  硬过滤只用人數 / 时长 / 类型机制，不用复杂度（传了会把结果过滤成空）。

**候选池（本次重做的核心）**：候选池定义与规则可用性统一由 `app.agent.pool` 提供。
本次筛选只是「从池里按条件挑一批」，**不改变池本身**；池内每款都带规则可用性标记，
逐条标注在推荐结果里，避免用户产生「刚推荐就说不认识」的落差。

**两条分支**：
1. 用户明确在问**某一款（某几款）具体游戏**（「阿瓦隆怎么样」「A 和 B 哪个好」）→ 走
   `game_focus_stream`，只用站内真实资料作答，并说明它是否在本次推荐列表内。
   ← 截图缺陷「追问阿瓦隆 → 候选未收录」就是缺了这一分支。
2. 用户在**要一批新游戏**（「推荐…」「类似…」）→ 走推荐流程（本模块主路径）。

LLM 只用于理解软性偏好（如「类似 Wingspan 但更轻量」）和生成推荐理由，
排序本身是纯代码决定——这样推荐结果稳定、可复现、可解释。
"""
from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from collections.abc import AsyncIterator

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from sqlalchemy import select

from app.agent import llm
from app.agent import pool as pool_mod
from app.agent import rag
from app.agent import tools as db_tools
from app.agent import memory as mem_mod
from app.agent.router import GAME_FOCUS_PAT as _GAME_FOCUS_PAT
from app.core.config import settings
from app.models.review import Review

log = logging.getLogger(__name__)

# 启用协同过滤所需的最少评分条数；低于此值一律降级并如实标注
MIN_RATINGS_FOR_CF = 20
# 交给 LLM 挑「1 主推 + 2 备选」的候选数
CANDIDATE_N = 6
GEN_TIMEOUT_SEC = 60.0

# 「要一批新游戏」的强信号：命中即走推荐主路径——此时句中的游戏名是**参照物**而非主题
_BATCH_REC_PAT = re.compile(
    r"推荐|求推|介绍一下有什么|类似|像.+一样|有什么游戏|哪些游戏|有啥游戏|选游戏|玩什么|"
    r"再来|再给|换一个|换个|还有别|其他推荐|别的推荐|同类|入门|随便|几人局|消遣|排行|榜单"
)
# 「在问某一款/某几款具体游戏」的信号：与批量信号互斥使用（口径见 router.GAME_FOCUS_PAT）

# 同 rule_qa：推理模型的思维链与正文共用 max_tokens，预算需留足
MAX_TOKENS_BY_MODE = {"fast": 2500, "deep": 3500}

# 候选池真推无可推时的透明兜底（L4）：确定性文本，不走 LLM（快且绝不含糊）。
# 原则：边界声明只能出现在这一层，且必须附带行动建议，不允许只甩一句「不在名单内」。
EXHAUSTED_TEXT = (
    "候选池里符合「{slots}」的都推荐过了（本站共收录 {total} 款）。\n"
    "接下来可以：\n"
    "1. 调整条件再筛：比如换个人数（4人/8人）、时长（30分钟以内）或类型（合作/策略/派对）；\n"
    "2. 告诉我你玩过哪些，我帮你排除后从剩余里挑；\n"
    "3. 从之前推荐的里任选一款，我直接给你讲它的规则。"
)

SYSTEM_PROMPT = """你是 TableMind 的桌游推荐助手。

硬性要求：
1. 只能从「候选游戏」里挑，禁止推荐列表以外的任何游戏，禁止编造游戏名。
2. 输出 1 个主推荐 + 2 个备选，**按候选列表给出的 rank 顺序取前 3**，不要打乱顺序改选别的
   （候选已由系统按相关度排好序，保证同一问题两次问得到同一答案）。
3. 每款推荐末尾必须原样带上它的规则标记（{mark_yes} 或 {mark_no}），提醒用户能否追问规则。
4. 只能依据所给资料写理由（人数、时长、分类、机制、适龄等真实字段），禁止编造评分或口碑。
5. 若候选为空，说明本站暂无符合条件的桌游，并附一句可操作的调整建议（换人数/时长/类型），不要硬凑。
6. 若用户提到的某款游戏不在「本站候选池名单」里，明确说明它不在本站候选池
   （不要说"搜索失败"或"无法查询"）；若它在池内但不在本次候选里，说明它只是没被本次条件选上。
7. 若资料注明「未启用协同过滤」，不要声称推荐参考了其他玩家喜好。
8. 中文作答，输出**纯文本**，禁止任何 Markdown 语法，用「1. 2. 3.」分点。
9. 不要暴露推理过程。
10. 追问「还有别的吗 / 再来几款 / 换一批」是**续推请求**：直接从候选里继续推荐即可，
    不要去核对某款游戏是否在名单内，也不要输出候选池边界声明。
11. 边界说明（候选池收录范围）只能作为兜底出现，且必须附带行动建议
    （调整人数/时长/类型，或从已推荐的里挑一款讲规则）；**永远不要只输出边界声明而不给任何可行建议**。
12. 用户在当前提问或上下文中提到某款游戏 = 用户已经知道它。该游戏及其**同族版本**
    （站内有名字前缀/子串关系的，如《三国杀》与《三国杀标准版》）**永远不得**出现在推荐列表里
    ——即使它就在候选池中、机制最匹配。"类似 X" 的 X、"X 怎么样" 的 X、"X 和 Y 哪个好" 的 X 与 Y 都不例外。
13. 有参照游戏时（"类似 X"），推荐理由必须显式说明和 X 的**相似点 + 差异点**
    （例如「和 X 一样靠隐藏身份取胜，但 X 是 40 分钟一局，这款 15 分钟，节奏更快」），
    **不允许只罗列机制标签**——用户已经知道 X 的机制。

回答模式：{mode_desc}"""

FOCUS_SYSTEM_PROMPT = """你是 TableMind 的桌游资料助手。用户在问某一款（或某几款）具体桌游。

1. 只能用「资料」里的事实作答；资料没写的（评分、口碑排名、价格、销量等）一律说
   「本站暂无该信息」，禁止推测或编造。
2. 每款游戏末尾必须原样标注它的规则可用性标记：
   {mark_yes} = 本站已收录该游戏规则书，可以直接追问玩法；
   {mark_no} = 本站尚未收录该游戏规则书，只能答基本情况。
3. 若用户还提到了不在「本站候选池名单」里的游戏，明确说明它不在本站候选池
   （不要说"搜索失败"或"无法查询"）。
4. 中文作答，纯文本，禁止 Markdown 语法，用「1. 2. 3.」分点。
5. 不要暴露推理过程。"""


_models: dict[str, ChatOpenAI] = {}


def _get_model(mode: str = "fast") -> ChatOpenAI:
    if mode not in _models:
        _models[mode] = ChatOpenAI(
            model=settings.LLM_MODEL,
            api_key=settings.LLM_API_KEY,
            base_url=settings.LLM_BASE_URL,
            # 低温：同一问题的「主推/备选」要稳定复现，不能两次问出两份不同名单
            temperature=0.3,
            max_tokens=MAX_TOKENS_BY_MODE.get(mode, MAX_TOKENS_BY_MODE["fast"]),
            streaming=True,
        )
    return _models[mode]


async def collaborative_scores(db) -> dict[int, float] | None:
    """基于评分的 item-based 协同过滤打分。

    数据不足（评分条数 < MIN_RATINGS_FOR_CF）时返回 None——此时任何 CF 分数都是编的，
    宁可不做。返回 dict[game_id, 0~1 归一化热度分]。
    """
    rows = (
        await db.execute(select(Review.user_id, Review.game_id, Review.rating))
    ).all()
    if len(rows) < MIN_RATINGS_FOR_CF:
        log.info("评分数据 %d 条 < %d，协同过滤降级（不启用）", len(rows), MIN_RATINGS_FOR_CF)
        return None

    item_users: dict[int, dict[int, float]] = defaultdict(dict)
    for user_id, game_id, rating in rows:
        if rating is None:
            continue
        item_users[int(game_id)][int(user_id)] = float(rating)

    # 以「平均评分 + 评分数量的置信度折减」作为 item 分，避免 1 条 5 分冲到榜首
    raw: dict[int, float] = {}
    for gid, votes in item_users.items():
        avg = sum(votes.values()) / len(votes)
        confidence = len(votes) / (len(votes) + 5)  # 少量投票打折
        raw[gid] = avg * confidence

    if not raw:
        return None
    top = max(raw.values()) or 1.0
    return {gid: round(v / top, 4) for gid, v in raw.items()}


def _jaccard(a: list[str] | None, b: list[str] | None) -> float:
    """两个标签集合的 Jaccard 相似度（内容过滤的排序依据）。"""
    sa, sb = set(a or []), set(b or [])
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _resume_slots(message: str, history, route):
    """抽取本次条件：路由槽位 > 当前句 > 历史里最近一条带条件的用户消息。

    追问（「有没有更轻的」）当前句没有条件时沿用上一轮，避免把 4 人局推荐变成全库乱推。
    时长分上下限：「1 小时以上」是下限（play_time_min），不是上限（play_time_max）。
    """
    players = getattr(route, "players", None)
    play_time_max = getattr(route, "play_time_max", None)
    play_time_min = getattr(route, "play_time_min", None)
    keyword = getattr(route, "keyword", None)
    if not (players or play_time_max or play_time_min or keyword):
        players = rag._extract_players(message)
        play_time_max = rag._extract_play_time(message)
        play_time_min = rag._extract_min_play_time(message)
    if not (players or play_time_max or play_time_min or keyword) and history:
        for role, content in reversed(history):
            if role == "user" and content and content.strip():
                players = rag._extract_players(content)
                play_time_max = rag._extract_play_time(content)
                play_time_min = rag._extract_min_play_time(content)
                break
    return players, play_time_max, play_time_min, keyword


async def _resolve_ref(db, message: str, history):
    """找出「类似 X」里的参照游戏：当前句优先，追问时从历史里带回。"""
    ref = await rag.identify_game(db, message)
    if ref is None and history:
        for role, content in reversed(history):
            if role == "user" and content:
                ref = await rag.identify_game(db, content)
                if ref is not None:
                    break
    return ref


async def game_focus_stream(
    db,
    games: list,
    *,
    message: str,
    mode: str = "fast",
    history: list[tuple[str, str]] | None = None,
    slots_text: str = "",
    picked_ids: set[int] | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """「用户问的是某款（某几款）具体游戏」时的回答。

    与推荐主路径的区别：**不做「从候选里挑」**，而是就这款游戏本身给出站内真实资料 +
    规则可用性标记。这样「推荐过 A → 追问 A 怎么样」永远答得出，不会再冒出
    「候选未收录」。
    """
    picked_ids = picked_ids or set()
    stats = await pool_mod.pool_stats(db)
    cov = await pool_mod.rules_coverage(db)
    roster = await pool_mod.pool_roster_text(db)

    focus = games[:3]
    blocks: list[dict] = []
    for g in focus:
        detail = await db_tools.get_game_detail(db, g.id) or {}
        n = int(cov.get(g.id, 0))
        detail["rule_chunks"] = n
        detail["rule_mark"] = pool_mod.mark_for(n)
        blocks.append(detail)

    # 确定性的口径说明：即使模型漏说，也保证「在本站池内 / 只是没被本次条件选上」被讲清楚
    prefix = ""
    if len(focus) == 1:
        g0 = focus[0]
        if picked_ids and g0.id not in picked_ids:
            prefix = pool_mod.in_pool_but_not_picked_text(
                g0.name, slots_text, pool_mod.mark_for(int(cov.get(g0.id, 0)))
            ) + "\n\n"
        yield "info", json.dumps(
            {"text": f"已定位站内收录的《{g0.name}》，按站内资料回答"}, ensure_ascii=False
        )
    else:
        yield "info", json.dumps(
            {"text": "已定位站内收录的 " + "、".join(f"《{g.name}》" for g in focus) + "，逐款对比"},
            ensure_ascii=False,
        )

    detail_text = json.dumps(blocks, ensure_ascii=False, indent=1)
    prompt_msgs = [
        {
            "role": "system",
            "content": FOCUS_SYSTEM_PROMPT.format(
                mark_yes=pool_mod.RULE_MARK_YES, mark_no=pool_mod.RULE_MARK_NO
            ),
        },
    ]
    for role, content in (history or [])[-2:]:
        if role in ("user", "assistant") and content:
            prompt_msgs.append({"role": role, "content": content[:500]})
    prompt_msgs.append(
        {
            "role": "user",
            "content": (
                f"本站候选池名单（推荐与问答只在此范围内）：{roster}\n\n"
                f"资料（均为本站真实收录，含规则可用性）：\n{detail_text}\n\n"
                f"用户的问题：{message}"
            ),
        }
    )

    total = 0
    try:
        if prefix:
            total += len(prefix)
            yield "delta", prefix
        async for kind, piece in llm.chat_stream(
            prompt_msgs,
            temperature=0.3,
            max_tokens=MAX_TOKENS_BY_MODE.get(mode, MAX_TOKENS_BY_MODE["fast"]),
            model=settings.LLM_MODEL,
            enable_thinking=False,
        ):
            if kind == "content" and piece:
                total += len(piece)
                yield "delta", piece
    except Exception as e:  # noqa: BLE001 - 生成失败就用确定性文本兜底，绝不能空答
        log.warning("单款说明生成失败，改用确定性文本兜底：%s", e)

    if total == 0:
        # 确定性兜底：纯字段拼装，不编造
        lines = [prefix] if prefix else []
        for d in blocks:
            bits = [f"{d.get('players')} 人"] if d.get("players") else []
            if d.get("play_time"):
                bits.append(f"约 {d['play_time']} 分钟")
            if d.get("publisher"):
                bits.append(str(d["publisher"]))
            head = f"《{d.get('name')}》" + (f"（{'、'.join(bits)}）" if bits else "")
            lines.append(head)
            if d.get("categories") or d.get("mechanics"):
                lines.append(
                    "分类/机制：" + "、".join([*(d.get("categories") or [])[:3], *(d.get("mechanics") or [])[:3]])
                )
            if d.get("description"):
                lines.append(str(d["description"])[:200])
            lines.append(f"规则可用性：{d.get('rule_mark')}")
            lines.append("")
        text = "\n".join(lines).strip()
        for piece in [text[i : i + 40] for i in range(0, len(text), 40)]:
            yield "delta", piece

    yield "done", json.dumps(
        {
            "mode": "game-focus",
            "games": [g.name for g in focus],
            "pool_total": stats["total"],
            "chars": total,
        },
        ensure_ascii=False,
    )


async def recommend_stream(
    db,
    message: str,
    *,
    user_id: int | None = None,
    mode: str = "fast",
    route=None,
    history: list[tuple[str, str]] | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """跑一次推荐，产出 (event, payload)：info? → delta* → done。"""
    players, play_time_max, play_time_min, keyword = _resume_slots(message, history, route)
    # LLM 抽出的 keyword 必须真的能当检索条件用，否则它会把候选池过滤成空集
    # （实测「我想找两人玩的游戏」抽到 keyword=「两人玩」→ 0 条）。
    keyword = await pool_mod.sanitize_keyword(db, keyword)
    slots_text = pool_mod.slot_desc(players, play_time_max, keyword, play_time_min)

    # 个性化：先查用户画像 + 近期情景记忆（与 RAG 语义记忆分开取），复杂度上限用于硬过滤
    personal = None
    complexity_max = None
    if user_id:
        profile = await mem_mod.get_profile(db, user_id)
        episodes = await mem_mod.get_recent_episodes(db, user_id)
        personal = mem_mod.format_personalization(profile, episodes)
        complexity_max = profile.max_complexity if profile else None

    ref = await _resolve_ref(db, message, history)

    # ── 分支判定：问「某一款/某几款具体游戏」→ 单款说明，不套「从候选里挑」的逻辑 ──
    named = await rag.identify_games(db, message)
    asks_batch = bool(_BATCH_REC_PAT.search(message))
    # 短句（≤15 字）多为直接点名某款游戏；长句必须命中「在问具体游戏」的信号，
    # 否则通用句里偶然出现的短副标题会把推荐请求误判成单款说明。
    asks_game = bool(_GAME_FOCUS_PAT.search(message)) or len(message.strip()) <= 15
    if named and not asks_batch and asks_game:
        picked_ids: set[int] = set()
        if len(named) == 1 and (players or play_time_max or play_time_min or keyword):
            picked = await pool_mod.load_pool(
                db,
                players=players,
                play_time_max=play_time_max,
                play_time_min=play_time_min,
                keyword=keyword,
                complexity_max=complexity_max,
                limit=CANDIDATE_N,
            )
            picked_ids = {int(c["id"]) for c in picked}
        async for ev in game_focus_stream(
            db,
            named,
            message=message,
            mode=mode,
            history=history,
            slots_text=slots_text,
            picked_ids=picked_ids,
        ):
            yield ev
        return

    stats = await pool_mod.pool_stats(db)
    # limit 给 30 而非 12：续推时要先排除「历史里已推荐过的」，池取得太浅会导致
    # 排除后无货可推，被误判成「推完了」。
    candidates, relaxed = await pool_mod.load_pool_relaxed(
        db,
        players=players,
        play_time_max=play_time_max,
        play_time_min=play_time_min,
        keyword=keyword,
        complexity_max=complexity_max,
        limit=30,
    )

    # ── 统一排除集：用户提到的（含 ref + named） + 同族 + 本会话已推荐 ──
    # 原则（一句话版）：用户提到某款游戏 = 用户已经知道它，禁止再推；「类似 X」的 X 也不例外。
    # 这是会话级的状态机：覆盖三类缺陷——追问去重、本轮锚点排除、参照家族排除。
    seen_text = "\n".join(c for role, c in (history or []) if role == "assistant" and c)
    mentioned: set[str] = set()
    if ref is not None and ref.name:
        mentioned.add(ref.name)
    for g in (named or []):
        if g and g.name:
            mentioned.add(g.name)
    if candidates and (mentioned or seen_text):
        kept: list[dict] = []
        d_named = d_family = d_seen = 0
        for c in candidates:
            n = c.get("name")
            if not n:
                continue
            if n in mentioned:
                d_named += 1
                continue
            # 同族：候选里任一款名若含 mentioned 任意项或被其包含（无 family 字段时退化）
            is_family = any((m and (m in n or n in m)) for m in mentioned)
            if is_family:
                d_family += 1
                continue
            if seen_text and n in seen_text:
                d_seen += 1
                continue
            kept.append(c)
        candidates = kept
        bits: list[str] = []
        if d_named:
            bits.append(f"你提到的 {d_named} 款")
        if d_family:
            bits.append(f"同族 {d_family} 款")
        if d_seen:
            bits.append(f"已看过的 {d_seen} 款")
        if bits:
            yield "info", json.dumps(
                {"text": "已避开" + "、".join(bits) + "，从候选池剩余款中继续"},
                ensure_ascii=False,
            )
    if not candidates:
        # 全部命中排除 → 放宽到全池再捞一次，仍无货才进入透明兜底（L4）
        all_rows = await pool_mod.load_pool(db, limit=50)
        kept: list[dict] = []
        for c in all_rows:
            n = c.get("name")
            if not n:
                continue
            if n in mentioned:
                continue
            if any((m and (m in n or n in m)) for m in mentioned):
                continue
            if seen_text and n in seen_text:
                continue
            kept.append(c)
        if kept:
            candidates = kept
            yield "info", json.dumps(
                {"text": "该条件下能排除的都排除了，已把范围放宽到整个候选池"},
                ensure_ascii=False,
            )
        else:
            text = EXHAUSTED_TEXT.format(
                slots=slots_text, total=len(all_rows) or stats["total"]
            )
            for piece in [text[i : i + 40] for i in range(0, len(text), 40)]:
                yield "delta", piece
            yield "done", json.dumps(
                {
                    "mode": "rec-exhausted",
                    "pool_total": stats["total"],
                    "chars": len(text),
                },
                ensure_ascii=False,
            )
            return
    # 如实说明放宽了什么：不说的话，用户会以为「这次推荐」本来就是无条件的
    if relaxed:
        yield "info", json.dumps(
            {"text": f"没有能同时满足「{slots_text}」的桌游，{relaxed}"}, ensure_ascii=False
        )

    # 内容过滤：有参照游戏（「类似 X」）时按标签相似度排序
    if ref is not None:
        ref_tags = list(ref.categories or []) + list(ref.mechanics or [])
        for c in candidates:
            c["_content_score"] = _jaccard(
                list(c.get("categories") or []) + list(c.get("mechanics") or []),
                ref_tags,
            )
        candidates.sort(key=lambda c: c.get("_content_score", 0.0), reverse=True)

    # 协同过滤：数据不足就如实降级
    cf = await collaborative_scores(db)
    cf_used = cf is not None
    if cf_used:
        for c in candidates:
            c["_cf_score"] = cf.get(c["id"], 0.0)
        candidates.sort(
            key=lambda c: (c.get("_cf_score", 0.0), c.get("_content_score", 0.0)),
            reverse=True,
        )

    # 用 info 而非 notice：这是提示性信息，不是「失败降级」，前端不应清空已生成内容
    if not cf_used:
        yield "info", json.dumps(
            {"text": "本站评分数据不足，暂未启用协同过滤，当前按内容相似度与硬条件推荐"},
            ensure_ascii=False,
        )

    top = candidates[:CANDIDATE_N]
    # 余量预告：让用户的追问有预期，也让「候选池边界」变成可控节奏而不是突然的终点
    remaining = len(candidates) - len(top)

    # 池口径：让用户知道「候选池是什么」，而不是以为系统随机决定有没有某款游戏
    scope = (
        f"按「{slots_text}」筛出 {len(top)} 款"
        if not relaxed
        else f"放宽条件后选出 {len(top)} 款"
    )
    tail = (
        f"；池里同条件下还有 {remaining} 款没推过，想继续可以说「还有别的吗」"
        if remaining > 0
        else ""
    )
    yield "info", json.dumps(
        {
            "text": (
                f"本次从本站候选池（共 {stats['total']} 款，"
                f"{stats['with_rules']} 款可查规则）中{scope}{tail}"
            )
        },
        ensure_ascii=False,
    )

    # 个性化提示：画像/情景已在上方查好，生成前告知用户
    if personal:
        yield "info", json.dumps(
            {"text": "已结合你此前在站内的偏好进行推荐"}, ensure_ascii=False
        )

    roster = await pool_mod.pool_roster_text(db)
    # 双保险：代码已统一排除，提示词再声明一次，防止漏网
    mention_note = ""
    if mentioned:
        shown = "、".join(f"《{m}》" for m in sorted(mentioned)[:6])
        if len(mentioned) > 6:
            shown += "等"
        mention_note = f"用户已知道这些游戏（**禁止再推**）：{shown}\n\n"
    seen_note = ""
    if seen_text:
        seen_names = [n for n in await pool_mod.pool_roster(db) if n in seen_text]
        if seen_names:
            shown = "、".join(f"《{n}》" for n in seen_names[:8])
            if len(seen_names) > 8:
                shown += "等"
            seen_note = f"本会话此前已推荐过（**禁止再推**）：{shown}\n\n"
    # 锚点对比：让模型在理由里显式写出「和参照游戏的相似点 + 差异点」
    anchor_note = ""
    if ref is not None and ref.name:
        anchor_note = (
            f"本轮参照游戏：《{ref.name}》——用户问的是它的「类似款」，"
            f"请在每条推荐的理由里写清楚和它**相似在哪、差在哪**（题材 / 机制 / 节奏 / 人数 / 时长等）。\n\n"
        )

    brief = [
        {
            "rank": i + 1,
            "name": c.get("name"),
            "players": c.get("players"),
            "play_time": c.get("play_time"),
            "min_age": c.get("min_age"),
            "categories": (c.get("categories") or [])[:4],
            "mechanics": (c.get("mechanics") or [])[:4],
            "rules": c.get("rule_mark"),
        }
        for i, c in enumerate(top)
    ]

    human = (
        mention_note
        + seen_note
        + anchor_note
        + f"本站候选池名单（推荐只在此范围内）：{roster}\n\n"
        "候选游戏（均为本站真实收录，已按相关度排好序，请按 rank 取前 3）：\n{cands}\n\n"
        "用户的需求：{question}"
    )
    if personal:
        human = personal + "\n\n" + human
    prompt = ChatPromptTemplate.from_messages(
        [("system", SYSTEM_PROMPT), ("human", human)]
    )
    chain = prompt | _get_model(mode) | StrOutputParser()

    total = 0
    try:
        async for chunk in chain.astream(
            {
                "mode_desc": rag.MODE_DESC.get(mode, rag.MODE_DESC["fast"]),
                "mark_yes": pool_mod.RULE_MARK_YES,
                "mark_no": pool_mod.RULE_MARK_NO,
                "cands": json.dumps(brief, ensure_ascii=False, indent=1),
                "question": message,
            }
        ):
            if chunk:
                total += len(chunk)
                yield "delta", chunk
    except Exception as e:  # noqa: BLE001
        log.warning("推荐理由生成失败：%s", e)
        raise

    # 同 rule_qa：正文为空就抛给上层降级，不返回空壳回答
    if total == 0:
        raise RuntimeError("推荐未生成任何正文（疑似推理模型思维链耗尽 token 预算）")

    yield "done", json.dumps(
        {
            "candidates": len(brief),
            "cf_used": cf_used,
            "ref_game": ref.name if ref else None,
            "pool_total": stats["total"],
            "chars": total,
        },
        ensure_ascii=False,
    )
