# @polsia:user-owned — tests for the direct Anthropic API fallback adapter.
# Transport is stubbed with httpx.MockTransport; the point is wire shape.
from __future__ import annotations

import json

import httpx
import pytest

from bridge.anthropic_fallback import AnthropicFallbackAdapter
from bridge.errors import SdkUnavailable, SubscriptionRateLimited


def _patch_httpx(monkeypatch, handler):
    """Install a MockTransport on every httpx.AsyncClient built in this test."""
    original_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)


@pytest.mark.asyncio
async def test_happy_path_posts_messages_and_returns_bridge_shape(monkeypatch):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["headers"] = {k.lower(): v for k, v in request.headers.items()}
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "msg_abc",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-4-7",
                "content": [{"type": "text", "text": "hello"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 11, "output_tokens": 2},
            },
        )

    _patch_httpx(monkeypatch, handler)
    a = AnthropicFallbackAdapter(api_key="sk-test")

    out = await a.complete(
        system="be brief",
        messages=[{"role": "user", "content": "say hello"}],
        model="claude-opus-4-7",
        max_tokens=50,
        tools=None,
    )

    assert seen["url"] == "https://api.anthropic.com/v1/messages"
    assert seen["method"] == "POST"
    assert seen["headers"]["x-api-key"] == "sk-test"
    assert seen["headers"]["anthropic-version"] == "2023-06-01"
    assert seen["body"]["model"] == "claude-opus-4-7"
    assert seen["body"]["system"] == "be brief"
    assert seen["body"]["messages"] == [{"role": "user", "content": "say hello"}]

    assert out["content"] == [{"type": "text", "text": "hello"}]
    assert out["stop_reason"] == "end_turn"
    assert out["model"] == "claude-opus-4-7"
    # API tokens honored (above the char/4 floor).
    assert out["input_tokens"] >= 11
    assert out["output_tokens"] >= 2


@pytest.mark.asyncio
async def test_tools_are_forwarded(monkeypatch):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "msg_x",
                "type": "message",
                "role": "assistant",
                "model": "m",
                "content": [
                    {"type": "tool_use", "id": "tu_1", "name": "http_get",
                     "input": {"url": "https://example.com"}}
                ],
                "stop_reason": "tool_use",
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    _patch_httpx(monkeypatch, handler)
    a = AnthropicFallbackAdapter(api_key="sk-test")
    tools = [{"name": "http_get", "description": "", "input_schema": {"type": "object"}}]
    out = await a.complete(
        system="", messages=[{"role": "user", "content": "do it"}],
        model="m", max_tokens=100, tools=tools,
    )
    assert seen["body"]["tools"] == tools
    assert out["stop_reason"] == "tool_use"
    assert out["content"][0]["type"] == "tool_use"


@pytest.mark.asyncio
async def test_429_raises_subscription_rate_limited(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text='{"error":"rate_limit"}')

    _patch_httpx(monkeypatch, handler)
    a = AnthropicFallbackAdapter(api_key="sk-test")
    with pytest.raises(SubscriptionRateLimited):
        await a.complete(
            system="", messages=[{"role": "user", "content": "x"}],
            model="m", max_tokens=10, tools=None,
        )


@pytest.mark.asyncio
async def test_401_raises_sdk_unavailable(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauth")

    _patch_httpx(monkeypatch, handler)
    a = AnthropicFallbackAdapter(api_key="sk-bad")
    with pytest.raises(SdkUnavailable):
        await a.complete(
            system="", messages=[{"role": "user", "content": "x"}],
            model="m", max_tokens=10, tools=None,
        )


def test_empty_api_key_rejected():
    with pytest.raises(ValueError):
        AnthropicFallbackAdapter(api_key="")
