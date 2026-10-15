"""意图路由：把提问分到「规则问答」或「桌游推荐」两条独立流水线。

为什么不是自主工具循环：两条路径的确定性都很高（一条是检索+引用，一条是过滤+排序），
让模型每次自主决定调什么工具只会增加不确定性、token 与延迟。Router 更可控、可评测、更省。

策略：**规则优先 + LLM 兜底**。
- 关键词能明确判定时不花 token（绝大多数提问都能命中）；
- 关键词冲突或都不命中时才交给 LLM 做结构化判定；
- LLM 不可用时抛错，交给上层（ai.py）回落到既有的 RAG 工作流，保证用户永远拿得到回答。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from app.agent import rag
from app.core.config import settings

log = logging.getLogger(__name__)

INTENT_RULE = "rule"      # 规则问答
INTENT_REC = "rec"        # 桌游推荐
INTENT_CLARIFY = "clarify"  # 无法判定，请用户澄清

# 路由超时：意图判定不该拖慢整体响应
ROUTE_TIMEOUT_SEC = 15.0

# 规则类提问的强信号：问的是「怎么运作」，而不是「选哪个」
RULE_PAT = re.compile(
    r"规则|怎么玩|怎么算|玩法|计分|得分|得分方式|如何得分|回合|胜利条件|胜负|"
    r"费用|花费|成本|可以吗|能不能|能否|限制|流程|阶段|组件|有什么用|作用|"
    r"结算|抽牌|弃牌|放置|建造|翻面|弃置|触发|结束条件"
)
# 推荐类提问的强信号：问的是「选哪个」
REC_PAT = re.compile(
    r"推荐|求推|介绍一下有什么|类似|像.+一样|好玩|适合|选游戏|有什么游戏|"
    r"玩什么|入门|新手|轻量|重度|合作类|对抗|几人局|消遣"
)
# 规则类的**弱信号**：问数量/配置（「有多少张」「开局拿多少钱」）。
# 之所以单独一档：「推荐几个适合4人玩的游戏」里也有「几个」，但那是推荐意图；
# 所以弱信号只在推荐信号未命中时才生效，避免抢走推荐类提问。
WEAK_RULE_PAT = re.compile(
    r"多少|几个|几张|几块|几枚|几名|有多少|一共|总共|总数|数量|几|"
    r"初始|开局|起始|配件|内容物|起手"
)

# 追问信号：省略主语、承接上文的短问句（「有没有详细教程」「那这个呢」「还有吗」「有没有更轻的」）。
# 命中它 → 结合上一轮意图沿用，而不是把当前孤立句判成 clarify。
_FOLLOWUP_PAT = re.compile(
    r"有没有|有吗|详细|具体|展开|再说|继续说|继续|接着|然后|还有|更多|再讲|举个例子|举例|"
    r"^那|^这|^它|^再|^还有|呢[？?]?$|怎么样|怎么说"
)

# 推荐类追问信号：承接上文但**明确在要新游戏**（「还有别的值得玩的吗」「换个推荐」）。
# 为什么必须单独一档：_FOLLOWUP_PAT 命中「还有」就无脑沿用上一轮意图，
# 于是「上一轮问规则 → 追问『还有别的值得玩的吗』」会被钉死在 rule（实测缺陷 C9）。
# 追问只该沿用「意图」，不该把**意图切换**也吃掉——要新游戏时应当切到 rec。
# 注意只收「要游戏」的强信号，不带「游戏/好玩/值得玩」的「还有别的要注意的吗」
# 仍是规则追问，不能误伤。
REC_FOLLOWUP_PAT = re.compile(
    r"推荐|别的游戏|其他游戏|别的什么游戏|还有什么好玩|还有别的吗|值得玩|"
    r"换一个|换款|换一个游戏|再来|再来几个|还要推荐|别的推荐|其他推荐|"
    r"类似的|同类型|同类|别的桌游|其他桌游"
)

# 「在问某一款 / 某几款具体游戏」的信号（单款说明、两款对比）。
# 与 REC_FOLLOWUP_PAT 互斥使用：命中它且没有「要一批新游戏」的信号时，
# 应当就这款游戏本身回答（资料 + 规则可用性），而不是从候选池里重新挑一批。
# 截图缺陷「推荐过 A → 追问 A 怎么样 → 答候选未收录」正是缺了这一判定。
GAME_FOCUS_PAT = re.compile(
    r"怎么样|怎样|如何|好玩|评价|值得|介绍|是什么|哪个好|哪个更|对比|区别|差异|适合"
)

# 孤立模糊短句：没有主语、没有条件，整套文本就是一个模糊片语。
# 为什么要单独拦一道：「好玩吗」会被 REC_PAT 的「好玩」直接判成求推荐，
# 但它没有主语（哪一款？），根本判不出意图，必须澄清。实测缺陷（L4 C 组）。
_VAGUE_ONLY_PAT = re.compile(
    r"^(?:嗯+|哦+|额+|啊+|哈+|好玩(?:吗|么)?|怎么样|这个怎么样|那个呢|那个怎么样|"
    r"继续|来一个|帮我看看|有没有|怎么说呢|那个东西是什么|这是什么)[？?。！!…~\s]*$"
)


def _is_vague_only(message: str) -> bool:
    """整句就是一个模糊片语（无主语、无条件）→ 判不了意图。"""
    return bool(_VAGUE_ONLY_PAT.match(message.strip()))


def _prev_decisive_route(history: list[tuple[str, str]] | None) -> tuple[Optional["Route"], Optional[str]]:
    """从历史里回溯最近一条「关键词能明确判定意图」的用户消息 → (Route, 文本)。

    为什么不能只看最后一条用户消息：多轮追问里最后一条往往也是模糊句
    （「有没有详细教程」），必须继续往前找到真正的主题轮（「七大奇迹怎么玩」）。
    """
    for role, content in reversed(history or []):
        if role != "user" or not content or not content.strip():
            continue
        text = content.strip()
        kw = route_by_keywords(text)
        if kw is not None:
            return kw, text
    return None, None


def _history_block(history: list[tuple[str, str]] | None, max_turns: int = 2) -> str:
    """把最近若干轮对话整理成给路由模型的上下文（无历史则返回空串）。"""
    if not history:
        return ""
    rows = history[-max_turns * 2:]
    lines = ["【最近的对话（用于判断当前提问是否是对上文的追问）】"]
    for role, content in rows:
        who = "用户" if role == "user" else "助手"
        c = (content or "").strip().replace("\n", " ")
        lines.append(f"{who}：{c[:120]}")
    return "\n".join(lines) + "\n\n"


@dataclass
class Route:
    """路由结果。slots 是给两条流水线用的结构化条件。"""

    intent: str
    game_hint: Optional[str] = None      # 提问里疑似出现的桌游名
    players: Optional[int] = None        # 人数
    play_time_max: Optional[int] = None  # 时长上限（分钟）
    play_time_min: Optional[int] = None  # 时长下限（分钟，「1 小时以上」→ 60）
    complexity_max: Optional[float] = None
    keyword: Optional[str] = None        # 类型/机制关键词
    via: str = "keyword"                 # keyword | llm


class _RouteSchema(BaseModel):
    """LLM 结构化输出的目标 schema。"""

    intent: str = Field(description="只能是 rule / rec / clarify 之一")
    game_hint: Optional[str] = Field(default=None, description="提问里出现的桌游名；没有就填 null")
    players: Optional[int] = Field(default=None, description="提到的游玩人数；没有就填 null")
    play_time_max: Optional[int] = Field(
        default=None,
        description="时长**上限**（分钟，如「90 分钟以内」）。若用户说的是「X 小时以上 / 超过 X 分钟」这类下限，这里填 null",
    )
    play_time_min: Optional[int] = Field(
        default=None,
        description="时长**下限**（分钟）。仅当用户说「X 小时以上 / 超过 X 分钟 / 至少 X 分钟」时填这个，否则 null",
    )
    keyword: Optional[str] = Field(
        default=None,
        description=(
            "**类型或机制**关键词，如 合作、德式、卡牌、策略、资源管理；没有就填 null。"
            "严禁把人数、时长、疑问词或整句片段（如「两人玩」「怎么样」「1小时以上」）当关键词"
        ),
    )


def _fix_time_window(
    play_time_max: Optional[int], play_time_min: Optional[int]
) -> tuple[Optional[int], Optional[int]]:
    """区间为空（上界 ≤ 下界）时丢弃上界。

    真实缺陷（2026-10-14 实测）：提问「帮我找 1 小时以上的策略游戏」里，正则正确抽出
    play_time_min=60，而 LLM 把同一个 60 也填进了 play_time_max，两者组成空区间
    （<=60 且 >=60 只留恰好 60 分钟的），筛出的候选与用户本意不符。
    用户说的是下限时，上界必须作废。
    """
    if play_time_max is not None and play_time_min is not None and play_time_max <= play_time_min:
        log.info("时长区间为空（max=%s ≤ min=%s），丢弃上界", play_time_max, play_time_min)
        return None, play_time_min
    return play_time_max, play_time_min


_ROUTE_PROMPT = """你是桌游助手的意图分类器。判断下面这条用户提问应该走哪条流水线：

- rule：用户在问某款**具名**桌游的具体规则/情况（回合流程、计分、费用、配件作用、胜负条件、
  边界情况），或对着**已点名的**游戏问「怎么样/好不好玩/值不值得」。
- rec：用户在求推荐、找类似游戏、按人数/时长/类型挑游戏。
- clarify：完全无法判断意图（例如只是打招呼、闲聊，或连「问规则」还是「求推荐」都看不出来）。

重要：
1. 若用户**点出了某款具体桌游的名字**（哪怕本站没收录它），就不要判 clarify——按上面的规则判 rule 或 rec，
   由下游如实说明它是否在站内收录范围。
2. 但**没有游戏名**的孤立短句（「这个怎么样？」「好玩吗」「嗯嗯」「来一个」「继续」）仍判 clarify，
   不要因为句中有「怎么样/好玩」就当成规则提问。
3. 若提供了「最近的对话」，且当前提问是缺少主语/条件的追问（如「有没有详细教程」「那这个呢」「还有吗」「有没有更轻的」），
   必须结合上文判断意图并沿用上一条话题，不要因为当前句孤立看模糊就判成 clarify。
4. keyword 只填**类型或机制**词（合作、德式、卡牌、策略、资源管理…）。
   人数、时长、疑问词、整句片段（如「两人玩」「怎么样」「1小时以上」）都不是 keyword，一律填 null——
   它们会作为检索条件去过滤游戏库，填错会让候选直接变空。
5. 时长方向要分清：「X 小时以上 / 超过 X 分钟 / 至少 X 分钟」是**下限**，填 play_time_min；
   「X 分钟以内 / 不超过 X」是**上限**，填 play_time_max。同一个数字不要两边都填。

{history_block}只输出结构化结果，不要解释。

用户提问：{message}"""


def _slots_from_text(message: str) -> dict:
    """复用 rag 里已验证的槽位抽取，避免两套正则各写一遍。"""
    return {
        "players": rag._extract_players(message),
        "play_time_max": rag._extract_play_time(message),
        "play_time_min": rag._extract_min_play_time(message),
        "complexity_max": rag._extract_complexity(message),
    }


def route_by_keywords(message: str) -> Optional[Route]:
    """关键词路由：能明确判定就返回 Route，否则返回 None 交给 LLM。"""
    hit_rule = bool(RULE_PAT.search(message))
    hit_rec = bool(REC_PAT.search(message))
    hit_weak_rule = bool(WEAK_RULE_PAT.search(message))

    if hit_rule == hit_rec:  # 都命中或都不命中 → 交给 LLM
        # 都不命中时，规则类的弱信号（问数量/配置）仍可直接判定，
        # 少一次 LLM 调用，也避开模型偶发返回不了 JSON 导致的整条链路降级。
        if hit_rule or not hit_weak_rule:
            return None
        # 但弱信号会误伤续推追问：「除了这**几**款还有别的吗」里的「几」来自「这几款」
        # 而非问数量。此时句中带「要新游戏」的强信号（REC_FOLLOWUP），绝不能判 rule——
        # 否则续推会被推进规则流水线，答成「候选池名单」边界声明（2026-10-15 截图缺陷）。
        if REC_FOLLOWUP_PAT.search(message):
            return None
        hit_rule = True

    intent = INTENT_RULE if hit_rule else INTENT_REC
    slots = _slots_from_text(message)
    return Route(intent=intent, via="keyword", **slots)


_model: ChatOpenAI | None = None


def _get_model() -> ChatOpenAI:
    """懒加载分类器模型：意图判定要快、要稳，故低温。

    max_tokens 给 600 而不是 200：推理模型的思维链与正文共用预算，
    实测 200 会在思维链里耗尽 → 结构化输出解析失败 → 退化到文本兜底（实测 warning）。
    """
    global _model
    if _model is None:
        _model = ChatOpenAI(
            model=settings.LLM_MODEL,
            api_key=settings.LLM_API_KEY,
            base_url=settings.LLM_BASE_URL,
            temperature=0.0,
            max_tokens=600,
            streaming=False,
        )
    return _model


def _parse_loose_json(text: str) -> Optional[dict]:
    """兜底解析：模型可能把 JSON 包在 ```json``` 或前后带解释文字。"""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _intent_from_text(text: str) -> Optional[str]:
    """从模型自由文本里兜底识别意图（该模型偶发返回不了 JSON，只吐关键词）。

    rule 的判定放在最后：因为 "rec" 可能作为子串出现在别的词里，
    而 clarify 是终态（判不了就别猜成 rule/rec）。
    """
    t = (text or "").lower()
    if "clarify" in t:
        return INTENT_CLARIFY
    if "rec" in t or "推荐" in text:
        return INTENT_REC
    if "rule" in t or "规则" in text:
        return INTENT_RULE
    return None


async def route(message: str, history: list[tuple[str, str]] | None = None) -> Route:
    """主入口：关键词优先 → 追问沿用上一轮意图 → LLM 结构化判定（带历史）。

    抛出 Exception 表示路由失败，由上层回落到既有 RAG 工作流。
    """
    # 回溯最近一条「能明确判定意图」的历史用户消息（跳过中间同样是模糊的追问句）
    prev_kw, prev_text = _prev_decisive_route(history)

    # 孤立模糊短句（无主语无条件）→ 澄清，**必须放在关键词路由之前**：
    # 「好玩吗」命中 REC_PAT 的「好玩」会被直接判成求推荐，但它没有主语（哪一款？）。
    # 「有历史」时不算孤立：追问该沿用上一轮意图（「继续」不该变成澄清）。
    if prev_kw is None and _is_vague_only(message):
        log.info("孤立模糊短句 → clarify：'%s'", message)
        return Route(intent=INTENT_CLARIFY, via="vague")

    kw = route_by_keywords(message)
    if kw is not None:
        # 关键词能明确判定（含游戏名/推荐词），直接用
        return kw

    slots = _slots_from_text(message)

    # 意图切换优先于意图沿用：当前句明确在「要新游戏」时直接判 rec，
    # 不能被上一轮的 rule 意图钉住（否则「问完规则再求推荐」会一直答规则）。
    if prev_kw is not None and bool(REC_FOLLOWUP_PAT.search(message)):
        prev_slots = _slots_from_text(prev_text or "")
        log.info("推荐类追问（切换意图）：'%s' → rec（上一轮为 %s）", message, prev_kw.intent)
        return Route(
            intent=INTENT_REC,
            game_hint=None,  # 要新游戏，不沿用上一轮的主题游戏
            players=slots["players"] or prev_slots["players"],
            play_time_max=slots["play_time_max"] or prev_slots["play_time_max"],
            play_time_min=slots["play_time_min"] or prev_slots["play_time_min"],
            complexity_max=slots["complexity_max"] or prev_slots["complexity_max"],
            keyword=None,
            via="switch-rec",
        )

    # 追问兜底：省略主语/条件的短追问（「有没有详细教程」「那这个呢」）沿用上一轮意图，
    # 避免因为当前句孤立看模糊而误判成 clarify。
    is_followup = bool(prev_kw) and (
        bool(_FOLLOWUP_PAT.search(message)) or len(message.strip()) <= 12
    )
    if is_followup:
        prev_slots = _slots_from_text(prev_text or "")
        log.info("追问沿用主题轮意图：'%s' → intent=%s", message, prev_kw.intent)
        return Route(
            intent=prev_kw.intent,
            game_hint=prev_kw.game_hint,
            players=slots["players"] or prev_slots["players"],
            play_time_max=slots["play_time_max"] or prev_slots["play_time_max"],
            play_time_min=slots["play_time_min"] or prev_slots["play_time_min"],
            complexity_max=slots["complexity_max"] or prev_slots["complexity_max"],
            keyword=prev_kw.keyword,
            via="history",
        )

    model = _get_model()
    prompt = _ROUTE_PROMPT.format(history_block=_history_block(history), message=message[:500])

    def _guard(intent: str) -> str:
        """有可用历史时，clarify 退化为沿用主题轮意图（有历史就优先用历史）。"""
        if intent == INTENT_CLARIFY and prev_kw is not None:
            log.info("路由判为 clarify，但有历史 → 沿用主题轮意图 %s", prev_kw.intent)
            return prev_kw.intent
        return intent

    # 首选 LangChain 的结构化输出（走 function calling / tool calling）
    try:
        structured = model.with_structured_output(_RouteSchema)
        res = await asyncio.wait_for(structured.ainvoke(prompt), ROUTE_TIMEOUT_SEC)
        intent = (res.intent or "").strip().lower()
        if intent not in (INTENT_RULE, INTENT_REC, INTENT_CLARIFY):
            intent = INTENT_CLARIFY
        pt_max, pt_min = _fix_time_window(
            res.play_time_max or slots["play_time_max"],
            res.play_time_min or slots["play_time_min"],
        )
        return Route(
            intent=_guard(intent),
            game_hint=res.game_hint,
            players=res.players or slots["players"],
            play_time_max=pt_max,
            play_time_min=pt_min,
            complexity_max=slots["complexity_max"],
            keyword=res.keyword or (prev_kw.keyword if prev_kw else None),
            via="llm",
        )
    except Exception as e:  # noqa: BLE001 - 结构化输出失败则用普通 JSON 兜底
        log.warning("结构化意图路由失败，改用普通 JSON 兜底：%s", e)

    try:
        raw = await asyncio.wait_for(model.ainvoke(prompt), ROUTE_TIMEOUT_SEC)
        raw_text = getattr(raw, "content", "") or ""
        data = _parse_loose_json(raw_text)
        if data:
            intent = str(data.get("intent", INTENT_CLARIFY)).strip().lower()
            if intent not in (INTENT_RULE, INTENT_REC, INTENT_CLARIFY):
                intent = INTENT_CLARIFY
            pt_max, pt_min = _fix_time_window(
                data.get("play_time_max") or slots["play_time_max"],
                data.get("play_time_min") or slots["play_time_min"],
            )
            return Route(
                intent=_guard(intent),
                game_hint=data.get("game_hint"),
                players=data.get("players") or slots["players"],
                play_time_max=pt_max,
                play_time_min=pt_min,
                complexity_max=slots["complexity_max"],
                keyword=data.get("keyword") or (prev_kw.keyword if prev_kw else None),
                via="llm-json",
            )
        # JSON 解析不了时，从自由文本里兜底识别意图，避免整条链路降级
        inferred = _intent_from_text(raw_text)
        if inferred is None:
            raise ValueError("模型既未返回 JSON，也未包含可识别的意图关键词")
        pt_max, pt_min = _fix_time_window(slots["play_time_max"], slots["play_time_min"])
        return Route(
            intent=_guard(inferred),
            game_hint=None,
            players=slots["players"],
            play_time_max=pt_max,
            play_time_min=pt_min,
            complexity_max=slots["complexity_max"],
            keyword=prev_kw.keyword if prev_kw else None,
            via="llm-text",
        )
    except Exception as e:  # noqa: BLE001
        log.warning("LLM 意图路由失败：%s", e)
        raise
