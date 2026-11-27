# @polsia:user-owned — tests for the OpenAI-compatible fallback adapter.
# Transport stubbed with httpx.MockTransport; wire shape only.
from __future__ import annotations

import json

import httpx
import pytest

from bridge.errors import SdkUnavailable, SubscriptionRateLimited
from bridge.openai_fallback import OpenAIFallbackAdapter


def _patch_httpx(monkeypatch, handler):
    original_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)


@pytest.mark.asyncio
async def test_anthropic_to_openai_text_mapping(monkeypatch):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = {k.lower(): v for k, v in request.headers.items()}
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "cmpl_1",
                "model": "some-model",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "hi back"},
                    }
                ],
                "usage": {"prompt_tokens": 7, "completion_tokens": 3},
            },
        )

    _patch_httpx(monkeypatch, handler)
    a = OpenAIFallbackAdapter(
        name="probe",
        api_key="sk-fake",
        base_url="https://example.test",
        model_override="some-model",
    )
    out = await a.complete(
        system="be brief",
        messages=[{"role": "user", "content": "hi"}],
        model="claude-opus-4-7",
        max_tokens=42,
        tools=None,
    )

    assert seen["url"] == "https://example.test/v1/chat/completions"
    assert seen["headers"]["authorization"] == "Bearer sk-fake"
    assert seen["body"]["model"] == "some-model"  # override wins
    assert seen["body"]["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hi"},
    ]
    assert "tools" not in seen["body"]

    assert out["content"] == [{"type": "text", "text": "hi back"}]
    assert out["stop_reason"] == "end_turn"
    assert out["model"] == "some-model"
    assert out["input_tokens"] >= 7
    assert out["output_tokens"] >= 3


@pytest.mark.asyncio
async def test_tool_calls_become_tool_use_blocks(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "cmpl_2",
                "model": "some-model",
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_abc",
                                    "type": "function",
                                    "function": {
                                        "name": "http_get",
                                        "arguments": '{"url":"https://example.com"}',
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            },
        )

    _patch_httpx(monkeypatch, handler)
    a = OpenAIFallbackAdapter(
        name="probe", api_key="k", base_url="https://x.test", model_override="m"
    )
    out = await a.complete(
        system="",
        messages=[{"role": "user", "content": "go"}],
        model="m",
        max_tokens=100,
        tools=[{"name": "http_get", "description": "", "input_schema": {"type": "object"}}],
    )
    assert out["stop_reason"] == "tool_use"
    assert len(out["content"]) == 1
    tu = out["content"][0]
    assert tu["type"] == "tool_use"
    assert tu["id"] == "call_abc"
    assert tu["name"] == "http_get"
    assert tu["input"] == {"url": "https://example.com"}


@pytest.mark.asyncio
async def test_tools_forwarded_as_function_specs(monkeypatch):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "k"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                "model": "m",
            },
        )

    _patch_httpx(monkeypatch, handler)
    a = OpenAIFallbackAdapter(
        name="probe", api_key="k", base_url="https://x.test", model_override="m"
    )
    schema = {"type": "object", "properties": {"url": {"type": "string"}}}
    await a.complete(
        system="",
        messages=[{"role": "user", "content": "go"}],
        model="m",
        max_tokens=10,
        tools=[{"name": "http_get", "description": "fetch", "input_schema": schema}],
    )
    assert seen["body"]["tools"] == [
        {
            "type": "function",
            "function": {"name": "http_get", "description": "fetch", "parameters": schema},
        }
    ]


@pytest.mark.asyncio
async def test_429_raises_subscription_rate_limited(monkeypatch):
    _patch_httpx(monkeypatch, lambda r: httpx.Response(429, text="rl"))
    a = OpenAIFallbackAdapter(
        name="probe", api_key="k", base_url="https://x.test", model_override="m"
    )
    with pytest.raises(SubscriptionRateLimited):
        await a.complete(
            system="", messages=[{"role": "user", "content": "x"}],
            model="m", max_tokens=10, tools=None,
        )


@pytest.mark.asyncio
async def test_401_raises_sdk_unavailable(monkeypatch):
    _patch_httpx(monkeypatch, lambda r: httpx.Response(401, text="nope"))
    a = OpenAIFallbackAdapter(
        name="probe", api_key="k", base_url="https://x.test", model_override="m"
    )
    with pytest.raises(SdkUnavailable):
        await a.complete(
            system="", messages=[{"role": "user", "content": "x"}],
            model="m", max_tokens=10, tools=None,
        )


@pytest.mark.asyncio
async def test_custom_auth_scheme_xapikey(monkeypatch):
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"] = {k.lower(): v for k, v in request.headers.items()}
        return httpx.Response(
            200,
            json={"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}],
                  "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                  "model": "m"},
        )

    _patch_httpx(monkeypatch, handler)
    a = OpenAIFallbackAdapter(
        name="probe", api_key="X", base_url="https://x.test", model_override="m",
        auth_scheme="x-api-key",
    )
    await a.complete(
        system="", messages=[{"role": "user", "content": "x"}],
        model="m", max_tokens=10, tools=None,
    )
    assert seen["headers"]["x-api-key"] == "X"
    assert "authorization" not in seen["headers"]


def test_empty_api_key_rejected():
    with pytest.raises(ValueError):
        OpenAIFallbackAdapter(
            name="probe", api_key="", base_url="https://x.test", model_override="m"
        )
