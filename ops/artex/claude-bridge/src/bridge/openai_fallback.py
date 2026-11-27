# @polsia:user-owned — OpenAI-compatible fallback adapter.
#
# Many LLM aggregators (Omniroute, FreeLLMAPI, Together, Groq, DeepInfra,
# OpenRouter, ...) expose an OpenAI-shaped `/v1/chat/completions` endpoint.
# This adapter converts between the bridge's internal Anthropic-flavored
# shape and that OpenAI shape in both directions, so a single implementation
# covers every one of them.
#
# One adapter instance == one upstream. Build several, chain them in
# build_app's fallback_adapters list, and the bridge tries each in turn
# when the primary subscription is rate-limited.
from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from bridge.errors import SdkUnavailable, SubscriptionRateLimited
from bridge.sdk_adapter import SdkAdapter

log = logging.getLogger("artex-claude-bridge.openai-fallback")

STOP_REASON_MAP = {
    "stop": "end_turn",
    "end_turn": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
}


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _messages_anthropic_to_openai(
    system: str, messages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if system:
        out.append({"role": "system", "content": system})
    for m in messages:
        role = m["role"]
        # Bridge normalizes content to a string before handing to the adapter.
        out.append({"role": role, "content": m["content"]})
    return out


def _tools_anthropic_to_openai(
    tools: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    out: list[dict[str, Any]] = []
    for t in tools:
        out.append(
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description") or "",
                    "parameters": t.get("input_schema") or {"type": "object"},
                },
            }
        )
    return out


def _openai_message_to_bridge_content(
    message: dict[str, Any],
) -> tuple[list[dict[str, Any]], bool]:
    """OpenAI 'message' object -> Anthropic-style content blocks.
    Returns (blocks, saw_tool_use)."""
    blocks: list[dict[str, Any]] = []
    saw_tool_use = False
    text = message.get("content")
    if isinstance(text, str) and text:
        blocks.append({"type": "text", "text": text})
    tool_calls = message.get("tool_calls") or []
    for tc in tool_calls:
        fn = tc.get("function") or {}
        raw_args = fn.get("arguments")
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args) if raw_args else {}
            except json.JSONDecodeError:
                # Pass through as a string so the planner sees what the model
                # actually said, rather than silently losing the call.
                args = {"_raw_arguments": raw_args}
        elif isinstance(raw_args, dict):
            args = raw_args
        else:
            args = {}
        blocks.append(
            {
                "type": "tool_use",
                "id": tc.get("id") or "",
                "name": fn.get("name") or "",
                "input": args,
            }
        )
        saw_tool_use = True
    if not blocks:
        blocks = [{"type": "text", "text": ""}]
    return blocks, saw_tool_use


class OpenAIFallbackAdapter(SdkAdapter):
    def __init__(
        self,
        *,
        name: str,
        api_key: str,
        base_url: str,
        model_override: str | None = None,
        timeout_seconds: float = 300.0,
        auth_scheme: str = "Bearer",
        extra_headers: dict[str, str] | None = None,
        chat_completions_path: str = "/v1/chat/completions",
    ) -> None:
        if not api_key:
            raise ValueError(f"{name}: api_key must be non-empty")
        self.name = name
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model_override = model_override
        self._timeout = timeout_seconds
        self._auth_scheme = auth_scheme
        self._extra_headers = dict(extra_headers or {})
        self._path = chat_completions_path

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self._auth_scheme.lower() == "bearer":
            h["authorization"] = f"Bearer {self._api_key}"
        elif self._auth_scheme.lower() == "x-api-key":
            h["x-api-key"] = self._api_key
        else:
            # Treat anything else as a raw header name: "X-Custom-Auth".
            h[self._auth_scheme] = self._api_key
        h.update(self._extra_headers)
        return h

    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        wire_model = self._model_override or model or "gpt-4o-mini"
        payload: dict[str, Any] = {
            "model": wire_model,
            "max_tokens": max_tokens,
            "messages": _messages_anthropic_to_openai(system, messages),
        }
        oai_tools = _tools_anthropic_to_openai(tools)
        if oai_tools:
            payload["tools"] = oai_tools

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self._base_url}{self._path}",
                    headers=self._headers(),
                    content=json.dumps(payload),
                )
        except httpx.TimeoutException as e:
            raise SdkUnavailable(f"{self.name}: upstream timed out ({e})") from e
        except httpx.HTTPError as e:
            raise SdkUnavailable(f"{self.name}: transport error ({e})") from e

        if resp.status_code == 429:
            raise SubscriptionRateLimited(
                f"{self.name}: upstream rate-limited (429): {resp.text[:200]}",
            )
        if resp.status_code in (401, 403):
            raise SdkUnavailable(
                f"{self.name}: auth failed ({resp.status_code}): check its API key"
            )
        if resp.status_code >= 400:
            raise SdkUnavailable(
                f"{self.name}: HTTP {resp.status_code}: {resp.text[:500]}"
            )

        body = resp.json()
        choices = body.get("choices") or []
        if not choices:
            raise SdkUnavailable(
                f"{self.name}: no choices in response: {json.dumps(body)[:300]}"
            )
        first = choices[0]
        message = first.get("message") or {}
        blocks, saw_tool_use = _openai_message_to_bridge_content(message)

        finish_reason = first.get("finish_reason") or "stop"
        stop_reason = STOP_REASON_MAP.get(finish_reason)
        if stop_reason is None:
            stop_reason = "tool_use" if saw_tool_use else "end_turn"

        usage = body.get("usage") or {}
        api_input = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        api_output = int(
            usage.get("completion_tokens") or usage.get("output_tokens") or 0
        )

        emitted_text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        emitted_tool_json = "".join(
            json.dumps(b.get("input") or {})
            for b in blocks
            if b.get("type") == "tool_use"
        )
        input_floor = _estimate_tokens(
            "\n\n".join(m["content"] for m in messages) + (system or "")
        )
        output_floor = _estimate_tokens(emitted_text + emitted_tool_json)

        return {
            "content": blocks,
            "stop_reason": stop_reason,
            "input_tokens": max(api_input, input_floor),
            "output_tokens": max(api_output, output_floor),
            "model": body.get("model") or wire_model,
        }
