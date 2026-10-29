"""P3 四维评测裁判（LLM-as-judge）。

一张评测卡只调一次裁判模型，一次给出四个指标，避免四倍调用成本：

- **Context Recall**：参考答案里的关键信息，有多少能在检索资料中找到。
  没有参考答案时该指标置 None（不臆造标准，也不参与均分）。
- **Context Precision**：检索资料里与问题相关的内容占比、以及相关片段是否靠前。
- **Faithfulness**：答案里的事实是否都能在资料中找到（衡量幻觉）。
- **Answer Relevance**：答案是否直接、完整地回应问题（衡量跑题）。

分数统一归一化到 0~1 入库；裁判返回 1~5 整数分。任何解析失败都不编造分数，
让调用方把这条用例标记为「裁判失败」，而不是把失败当成 0 分污染均值。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from app.agent import llm
from app.core.config import settings

_JUDGE_PROMPT = """你是 RAG 系统的评测裁判。下面给出【问题】【参考资料】【系统回答】，{ref_note}
请严格依据以下四条标准打分，每条 1~5 的整数（5 最好，1 最差）：

- context_recall：{recall_rule}
- context_precision：参考资料中与问题相关的内容占比，以及相关片段是否排在前面。5=几乎全是相关内容且靠前；1=几乎全是噪声。
- faithfulness：回答中的每一个事实是否都能在参考资料里找到依据。5=全部有据；1=大量编造或与资料矛盾。
  注意：若回答声称「无法回答 / 资料不足 / 请自行查阅说明书」，而参考资料里其实有答案，
  这属于与资料矛盾，faithfulness 记 1~2 分。
- answer_relevance：回答是否直接回应了问题（不跑题、不空泛）。5=完全切题；1=答非所问。
  拒答、只给免责声明而没有回答问题的，记 1~2 分。

只输出一个 JSON 对象，不要 Markdown、不要解释、不要多余文字。reason 控制在 60 字以内。格式：
{{
  "context_recall": {{"score": 4, "reason": "一句话理由"}},
  "context_precision": {{"score": 5, "reason": "一句话理由"}},
  "faithfulness": {{"score": 5, "reason": "一句话理由"}},
  "answer_relevance": {{"score": 4, "reason": "一句话理由"}}
}}

问题：{question}

参考答案：{reference}

参考资料：
{contexts}

系统回答：{answer}"""

_NO_REF_RULE = "本次没有参考答案：context_recall 的 score 必须输出 null。"
_HAS_REF_RULE = "context_recall 按「参考答案被资料覆盖的程度」打分。"

_MAX_CONTEXT_CHARS = 9000
_MAX_ANSWER_CHARS = 4000


@dataclass
class JudgeResult:
    """裁判输出（分数已归一化到 0~1）。"""

    context_recall: float | None = None
    context_precision: float | None = None
    faithfulness: float | None = None
    answer_relevance: float | None = None
    overall: float | None = None
    reasons: dict = field(default_factory=dict)
    raw: str = ""
    error: str | None = None


def _format_contexts(contexts: list[str]) -> str:
    parts: list[str] = []
    used = 0
    for i, text in enumerate(contexts, 1):
        body = (text or "").strip()
        if not body:
            continue
        remain = _MAX_CONTEXT_CHARS - used
        if remain <= 0:
            break
        body = body[:remain]
        used += len(body)
        parts.append(f"【片段{i}】{body}")
    return "\n\n".join(parts) or "（无检索资料）"


def _normalize_score(v: object) -> float | None:
    """把裁判给的分数归一化到 0~1。

    - 1~5 整数（提示词要求）：除以 5；
    - 0~1 的小数（模型偶尔直接用比例）：原样保留；
    - null / 非数字：None。
    """
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if 0.0 < f < 1.0:
        return round(f, 4)
    if 1.0 <= f <= 5.0:
        return round(f / 5.0, 4)
    # 越界值夹到边界，但 0 分说明模型没按 rubric 打分，视为无效
    if f <= 0:
        return None
    return 1.0


def parse_judge(raw: str, has_reference: bool) -> JudgeResult:
    """解析裁判输出。纯函数，便于离线自检。"""
    res = JudgeResult(raw=raw or "")
    if not raw or not raw.strip():
        res.error = "裁判返回为空"
        return res

    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        res.error = "裁判输出不是 JSON"
        return res
    try:
        data = json.loads(m.group(0))
    except (ValueError, TypeError):
        res.error = "裁判 JSON 解析失败"
        return res
    if not isinstance(data, dict):
        res.error = "裁判 JSON 结构异常"
        return res

    reasons: dict[str, str] = {}
    for key in ("context_recall", "context_precision", "faithfulness", "answer_relevance"):
        item = data.get(key)
        if isinstance(item, dict):
            score = _normalize_score(item.get("score"))
            reason = item.get("reason")
        else:
            score = _normalize_score(item)
            reason = None
        if isinstance(reason, str) and reason.strip():
            reasons[key] = reason.strip()[:300]
        if key == "context_recall" and not has_reference:
            score = None
        setattr(res, key, score)

    vals = [
        v
        for v in (
            res.context_recall,
            res.context_precision,
            res.faithfulness,
            res.answer_relevance,
        )
        if v is not None
    ]
    if not vals:
        res.error = "裁判未给出任何有效分数"
    else:
        res.overall = round(sum(vals) / len(vals), 4)
    res.reasons = reasons
    return res


async def judge_case(
    question: str,
    answer: str,
    contexts: list[str],
    reference_answer: str | None,
) -> JudgeResult:
    """跑一次四维裁判。未配置密钥直接返回 error，由调用方记录。"""
    if not llm.available():
        return JudgeResult(error="未配置大模型密钥，无法评测")

    has_ref = bool((reference_answer or "").strip())
    prompt = _JUDGE_PROMPT.format(
        ref_note=_HAS_REF_RULE if has_ref else _NO_REF_RULE,
        recall_rule=(
            "参考答案中的关键信息有多少能在参考资料里找到。5=全部覆盖；1=几乎没覆盖。"
            if has_ref
            else "本次无参考答案，输出 null"
        ),
        question=(question or "").strip(),
        reference=(reference_answer or "").strip()[:_MAX_ANSWER_CHARS] or "（无）",
        contexts=_format_contexts(contexts),
        answer=(answer or "").strip()[:_MAX_ANSWER_CHARS] or "（空回答）",
    )
    try:
        raw = await llm.chat_complete(
            [
                {"role": "system", "content": "你是严谨的 RAG 评测裁判，只输出 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=settings.EVAL_JUDGE_TEMPERATURE,
            max_tokens=settings.EVAL_JUDGE_MAX_TOKENS,
            model=settings.EVAL_JUDGE_MODEL or settings.LLM_MODEL,
            enable_thinking=False,
        )
    except Exception as e:  # noqa: BLE001
        return JudgeResult(error=f"裁判调用失败：{e}")
    return parse_judge(raw, has_ref)


if __name__ == "__main__":
    # 自检：不依赖 LLM，验证三种常见返回格式与缺参考答案的情况。
    r = parse_judge(
        '{"context_recall":{"score":4,"reason":"覆盖大半"},'
        '"context_precision":{"score":5,"reason":"全相关"},'
        '"faithfulness":{"score":5,"reason":"有据"},'
        '"answer_relevance":{"score":4,"reason":"切题"}}',
        True,
    )
    assert (r.context_recall, r.context_precision, r.faithfulness, r.answer_relevance) == (
        0.8,
        1.0,
        1.0,
        0.8,
    ), r
    assert r.overall == 0.9
    assert r.reasons["faithfulness"] == "有据"

    r2 = parse_judge(
        "```json\n{\"context_recall\":null,\"context_precision\":0.5,"
        "\"faithfulness\":3,\"answer_relevance\":2}\n```",
        False,
    )
    assert r2.context_recall is None and r2.context_precision == 0.5
    assert r2.faithfulness == 0.6 and r2.answer_relevance == 0.4
    assert r2.overall == round((0.5 + 0.6 + 0.4) / 3, 4)

    r3 = parse_judge("不是 JSON", True)
    assert r3.error and r3.overall is None

    r4 = parse_judge('{"context_recall":5,"context_precision":4,"faithfulness":2,"answer_relevance":1}', False)
    assert r4.context_recall is None and r4.overall == round((0.8 + 0.4 + 0.2) / 3, 4)

    print("judge self-test OK")
