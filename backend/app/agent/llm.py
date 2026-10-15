"""大模型客户端（OpenAI 兼容协议，当前接入阿里云百炼 DashScope）。

只依赖 httpx，不引入 SDK，方便换任意兼容端点。
流式解析同时兼容「推理模型」与「普通对话模型」两类响应：
推理模型（如 deepseek-v4.1-flash）先吐 `delta.reasoning_content`（思维链）、
之后才是 `delta.content`（正式回答）；普通模型（当前使用的 qwen-flash）只吐 content。
两种都处理，换模型时无需改解析逻辑。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.core.config import settings

import logging

log = logging.getLogger(__name__)

# 复用的 httpx 异步客户端：连接池复用，避免每次请求新建连接的开销（httpx 官方推荐用法）。
_httpx_client = None

def _get_client() -> 'httpx.AsyncClient | None':
    global _httpx_client
    if _httpx_client is None or _httpx_client.is_closed:
        _httpx_client = httpx.AsyncClient()
    return _httpx_client

# embedding 客户端（懒加载；未安装 openai 包时返回 None，embed 降级）。
_embed_client = None

def _get_embed_client():
    global _embed_client
    if _embed_client is None:
        try:
            from openai import AsyncOpenAI
        except ImportError:
            return None
        _embed_client = AsyncOpenAI(api_key=settings.LLM_API_KEY, base_url=settings.LLM_BASE_URL)
    return _embed_client

# embedding 结果缓存：同一查询串重复计算代价高（每次 RAG 检索都算），进程内复用。
_embed_cache: dict = {}
_EMBED_CACHE_MAX = 2000

# 单条消息的角色
Role = str


class LLMError(Exception):
    """调用大模型失败。kind 用于上层决定文案与是否降级。"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


def available() -> bool:
    """是否配置了可用的大模型（没配 key 时后端走站内检索降级）。"""
    return bool(settings.LLM_API_KEY.strip())


def model_name() -> str:
    return settings.LLM_MODEL


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.LLM_API_KEY}",
        "Content-Type": "application/json",
    }


def _endpoint() -> str:
    return settings.LLM_BASE_URL.rstrip("/") + "/chat/completions"


def _classify(status: int, body: str) -> LLMError:
    """把 HTTP 错误翻译成可读原因。

    特别注意：百炼在**免费额度耗尽**时返回的是 403 + `AllocationQuota.FreeTierOnly`，
    若笼统按「鉴权失败、请检查密钥」提示，会把排查方向带偏（密钥其实是好的）。
    故先按响应体识别配额类错误，其余再按状态码归类。
    """
    blob = (body or "").lower()
    if "freetieronly" in blob or "free quota" in blob or ("quota" in blob and "exhaust" in blob):
        return LLMError(
            "quota",
            f"大模型免费额度已耗尽（HTTP {status}，当前 LLM_MODEL={settings.LLM_MODEL}）："
            "请在百炼控制台充值或关闭「仅使用免费额度」，或改用其它可用模型",
        )
    if "access_denied" in blob or "model_not_found" in blob or "model not exist" in blob:
        return LLMError(
            "model", f"当前账号无权访问该模型（HTTP {status}，LLM_MODEL={settings.LLM_MODEL}）"
        )
    if status in (401, 403):
        return LLMError("auth", f"大模型鉴权失败（HTTP {status}）：请检查 LLM_API_KEY")
    if status == 429:
        return LLMError("quota", "大模型调用过于频繁或额度不足（HTTP 429）")
    if status >= 500:
        return LLMError("server", f"大模型服务端异常（HTTP {status}）")
    return LLMError("bad_request", f"大模型请求被拒绝（HTTP {status}）：{body[:200]}")


def _payload(
    messages: list[dict[str, Role | str]],
    temperature: float,
    max_tokens: int | None,
    stream: bool,
    *,
    model: str | None = None,
    enable_thinking: bool = True,
) -> dict[str, Any]:
    p: dict[str, Any] = {
        "model": model or settings.LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        # 推理模型的思维链也计入 max_tokens，给不足会导致正文一个字都出不来
        "max_tokens": max_tokens or settings.LLM_MAX_TOKENS,
        "stream": stream,
    }
    # 规则问答/改写是知识检索型任务，不需要冗长思维链：关掉可大幅降低首字延迟
    if not enable_thinking:
        p["enable_thinking"] = False
    return p


def _log_usage(call: str, usage: dict | None) -> None:
    """记录单次 LLM 调用的 token 用量（用于成本计量；异常不影响主流程）。"""
    if not (settings.LLM_LOG_USAGE and usage):
        return
    try:
        prompt = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        completion = usage.get("completion_tokens") or usage.get("output_tokens") or 0
        log.info("[llm-usage] %s prompt=%s completion=%s", call, prompt, completion)
    except Exception:  # noqa: BLE001
        pass


async def chat_complete(
    messages: list[dict[str, Any]],
    *,
    temperature: float = 0.6,
    max_tokens: int | None = None,
    model: str | None = None,
    enable_thinking: bool = True,
) -> str:
    """非流式调用，返回完整正文。失败抛 LLMError。"""
    if not available():
        raise LLMError("unconfigured", "未配置大模型密钥")

    timeout = httpx.Timeout(settings.LLM_TIMEOUT, connect=15)
    try:
        resp = await _get_client().post(
            _endpoint(), headers=_headers(),
            json=_payload(messages, temperature, max_tokens, False,
                          model=model, enable_thinking=enable_thinking),
            timeout=timeout,
        )
    except httpx.TimeoutException:
        raise LLMError("timeout", "大模型响应超时")
    except httpx.HTTPError as e:
        raise LLMError("network", f"无法连接大模型服务：{e}")

    if resp.status_code != 200:
        raise _classify(resp.status_code, resp.text)

    try:
        data = resp.json()
        _log_usage("chat_complete", data.get("usage"))
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, ValueError):
        raise LLMError("bad_response", "大模型返回结构异常")


async def chat_with_tools(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    *,
    temperature: float = 0.3,
    max_tokens: int | None = None,
    tool_choice: str | dict[str, Any] = "auto",
    model: str | None = None,
    enable_thinking: bool = True,
) -> dict[str, Any]:
    """带工具定义的非流式调用，返回 {content, reasoning, tool_calls}。

    tool_calls 元素形如 {"id":..., "name":..., "arguments": dict}。
    模型若判断无需工具，则 tool_calls 为空、content 为最终回答。
    失败抛 LLMError（由上层决定是否降级到无工具路径）。
    """
    if not available():
        raise LLMError("unconfigured", "未配置大模型密钥")

    payload = _payload(messages, temperature, max_tokens, False,
                       model=model, enable_thinking=enable_thinking)
    payload["tools"] = tools
    payload["tool_choice"] = tool_choice

    timeout = httpx.Timeout(settings.LLM_TIMEOUT, connect=15)
    try:
        resp = await _get_client().post(_endpoint(), headers=_headers(), json=payload, timeout=timeout)
    except httpx.TimeoutException:
        raise LLMError("timeout", "大模型响应超时")
    except httpx.HTTPError as e:
        raise LLMError("network", f"无法连接大模型服务：{e}")

    if resp.status_code != 200:
        raise _classify(resp.status_code, resp.text)

    try:
        msg = resp.json()["choices"][0]["message"]
    except (KeyError, IndexError, ValueError):
        raise LLMError("bad_response", "大模型返回结构异常")

    calls: list[dict[str, Any]] = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        raw = fn.get("arguments")
        if isinstance(raw, str):
            try:
                args = json.loads(raw) if raw.strip() else {}
            except ValueError:
                args = {}
        else:
            args = raw or {}
        calls.append(
            {"id": tc.get("id") or "", "name": fn.get("name") or "", "arguments": args}
        )

    return {
        "content": (msg.get("content") or "").strip(),
        "reasoning": (msg.get("reasoning_content") or "").strip(),
        "tool_calls": calls,
    }


async def embed(text: str) -> list[float] | None:
    """生成单条文本的 embedding 向量（OpenAI 兼容协议，当前为百炼）。

    维度见 settings.EMBEDDING_MODEL，必须与数据库 Vector(N) 一致。
    未配置密钥 / 无 openai 包 / 调用失败均返回 None（由上层降级）。
    """
    if not available():
        return None
    key = text[:8000]
    cached = _embed_cache.get(key)
    if cached is not None:
        return cached

    client = _get_embed_client()
    if client is None:
        return None
    try:
        dim = getattr(settings, "EMBEDDING_DIM", None)
        kwargs = {"dimensions": dim} if dim else {}
        resp = await client.embeddings.create(
            model=settings.EMBEDDING_MODEL, input=key, **kwargs
        )
        vec = list(resp.data[0].embedding)
    except Exception:
        return None

    if len(_embed_cache) >= _EMBED_CACHE_MAX:
        _embed_cache.clear()
    _embed_cache[key] = vec
    return vec


async def chat_stream(
    messages: list[dict[str, Any]],
    *,
    temperature: float = 0.6,
    max_tokens: int | None = None,
    model: str | None = None,
    enable_thinking: bool = True,
) -> AsyncIterator[tuple[str, str]]:
    """流式调用，逐段产出 (kind, text)。

    kind='reasoning' 是思维链（可用于「思考中」提示，不必展示给用户）；
    kind='content' 是正式回答正文。
    """
    if not available():
        raise LLMError("unconfigured", "未配置大模型密钥")

    timeout = httpx.Timeout(settings.LLM_TIMEOUT, connect=15)
    client = _get_client()
    stream_payload = _payload(
        messages, temperature, max_tokens, True,
        model=model, enable_thinking=enable_thinking,
    )
    stream_payload["stream_options"] = {"include_usage": True}
    try:
        async with client.stream(
            "POST",
            _endpoint(),
            headers=_headers(),
            json=stream_payload,
            timeout=timeout,
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", "ignore")
                raise _classify(resp.status_code, body)

            async for line in resp.aiter_lines():
                if not line:
                    continue
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    if payload == "[DONE]":
                        break
                    continue
                try:
                    chunk = json.loads(payload)
                except ValueError:
                    continue

                # 用量通常在最后一个空 choices 的 chunk 里
                if chunk.get("usage"):
                    _log_usage("chat_stream", chunk["usage"])

                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    reasoning = delta.get("reasoning_content")
                    if reasoning:
                        yield "reasoning", reasoning
                    content = delta.get("content")
                    if content:
                        yield "content", content
    except httpx.TimeoutException:
        raise LLMError("timeout", "大模型响应超时")
    except httpx.HTTPError as e:
        raise LLMError("network", f"无法连接大模型服务：{e}")
