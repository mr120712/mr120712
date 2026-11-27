# @polsia:user-owned — direct Anthropic API fallback adapter.
#
# When the user's Claude Code subscription hits a hard window (five_hour /
# seven_day), the primary adapter raises `SubscriptionRateLimited`. If the
# operator has set `ANTHROPIC_FALLBACK_API_KEY`, the route handler tries
# THIS adapter: a direct POST to api.anthropic.com/v1/messages with that
# key. Payment model is pay-per-token on that key, NOT the subscription.
#
# This adapter speaks Anthropic's Messages API natively, so the mapping is
# almost 1:1 with what the route handler already hands in. The only shape
# shift is flattening the response's `usage` into the dict the bridge
# returns to _success_response.
#
# System prompt, tools, text-only, tool_use passthrough: same shape as the
# primary adapter, so the route treats the two interchangeably.
from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from bridge.errors import SdkUnavailable, SubscriptionRateLimited
from bridge.sdk_adapter import SdkAdapter

log = logging.getLogger("artex-claude-bridge.fallback")

ANTHROPIC_API_BASE = "https://api.anthropic.com"
ANTHROPIC_API_VERSION = "2023-06-01"


def _flatten_messages_to_anthropic(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Primary adapter normalized messages to {role, content:str}. The
    Anthropic API accepts that shape directly. system is passed separately."""
    return [{"role": m["role"], "content": m["content"]} for m in messages]


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class AnthropicFallbackAdapter(SdkAdapter):
    name = "anthropic-api"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = ANTHROPIC_API_BASE,
        timeout_seconds: float = 300.0,
    ) -> None:
        if not api_key:
            raise ValueError("AnthropicFallbackAdapter needs a non-empty api_key")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds

    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model or "claude-opus-4-7",
            "max_tokens": max_tokens,
            "messages": _flatten_messages_to_anthropic(messages),
        }
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = tools

        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "content-type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    f"{self._base_url}/v1/messages",
                    headers=headers,
                    content=json.dumps(payload),
                )
        except httpx.TimeoutException as e:
            raise SdkUnavailable(f"fallback: upstream timed out ({e})") from e
        except httpx.HTTPError as e:
            raise SdkUnavailable(f"fallback: transport error ({e})") from e

        # Rate limit on the fallback too: pass it up so the route can decide
        # (now we really ARE stuck — the sub is capped AND the paid key is
        # capped). The route maps SubscriptionRateLimited to 429.
        if resp.status_code == 429:
            raise SubscriptionRateLimited(
                f"Anthropic fallback also rate-limited (429): {resp.text[:200]}",
            )
        if resp.status_code == 401 or resp.status_code == 403:
            raise SdkUnavailable(
                f"Anthropic fallback auth failed ({resp.status_code}): "
                f"check ANTHROPIC_FALLBACK_API_KEY"
            )
        if resp.status_code >= 400:
            raise SdkUnavailable(
                f"Anthropic fallback HTTP {resp.status_code}: {resp.text[:500]}"
            )

        body = resp.json()

        content_blocks = body.get("content") or []
        stop_reason = body.get("stop_reason") or "end_turn"
        model_used = body.get("model") or model or "unknown"
        usage = body.get("usage") or {}
        api_input = int(usage.get("input_tokens") or 0)
        api_output = int(usage.get("output_tokens") or 0)

        # Floor at our own char-based estimate, same as the primary adapter,
        # so downstream accounting is consistent across both paths.
        emitted_text = "".join(
            b.get("text", "") for b in content_blocks if b.get("type") == "text"
        )
        emitted_tool_json = "".join(
            json.dumps(b.get("input") or {})
            for b in content_blocks
            if b.get("type") == "tool_use"
        )
        input_floor = _estimate_tokens(
            "\n\n".join(m["content"] for m in messages) + (system or "")
        )
        output_floor = _estimate_tokens(emitted_text + emitted_tool_json)

        return {
            "content": content_blocks,
            "stop_reason": stop_reason,
            "input_tokens": max(api_input, input_floor),
            "output_tokens": max(api_output, output_floor),
            "model": model_used,
        }
