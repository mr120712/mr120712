# @polsia:user-owned — RED tests for the real `ClaudeSdkAdapter`. The SDK's
# `query` function is monkeypatched so these tests describe the adapter's
# contract without actually spawning a `claude` CLI subprocess.
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator

import pytest

from bridge.errors import SubscriptionRateLimited
from bridge.sdk_adapter_impl import ClaudeSdkAdapter


@dataclass
class _Text:
    text: str


@dataclass
class _ToolUse:
    id: str
    name: str
    input: dict


@dataclass
class _Assistant:
    content: list[Any]
    model: str = "claude-opus-4-7"
    parent_tool_use_id: Any = None
    error: Any = None
    usage: dict | None = None
    message_id: str | None = None
    stop_reason: str | None = "end_turn"
    session_id: str | None = None
    uuid: str | None = None
    user_message_uuid: str | None = None
    user_message_uuids: Any = None


@dataclass
class _Result:
    usage: dict | None = None
    api_error_status: int | None = None
    terminal_reason: str | None = None
    subtype: str = "success"
    duration_ms: int = 0
    duration_api_ms: int = 0
    is_error: bool = False
    num_turns: int = 1
    session_id: str = "s"
    stop_reason: str | None = "end_turn"
    total_cost_usd: float | None = None
    result: str | None = None
    structured_output: Any = None
    model_usage: Any = None
    permission_denials: Any = None
    deferred_tool_use: Any = None
    errors: Any = None
    uuid: str | None = None
    origin: Any = None
    user_message_uuid: str | None = None
    user_message_uuids: Any = None


@dataclass
class _RateLimitInfo:
    status: str
    resets_at: int | None = None
    rate_limit_type: str | None = None
    utilization: float | None = None
    overage_status: str | None = None
    overage_resets_at: int | None = None
    overage_disabled_reason: str | None = None
    raw: dict | None = None


@dataclass
class _RateLimitEvent:
    rate_limit_info: _RateLimitInfo
    uuid: str = "u"
    session_id: str = "s"


def _fake_query_factory(stream_items: list[Any]):
    async def _fake_query(*, prompt, options=None, transport=None) -> AsyncIterator[Any]:
        _fake_query.last_prompt = prompt  # type: ignore[attr-defined]
        _fake_query.last_options = options  # type: ignore[attr-defined]
        for item in stream_items:
            yield item

    _fake_query.last_prompt = None  # type: ignore[attr-defined]
    _fake_query.last_options = None  # type: ignore[attr-defined]
    return _fake_query


async def test_collects_assistant_text_and_usage(monkeypatch) -> None:
    fake = _fake_query_factory(
        [
            _Assistant(content=[_Text(text="Hello"), _Text(text=" world")]),
            _Result(usage={"input_tokens": 20, "output_tokens": 5}),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)

    a = ClaudeSdkAdapter()
    out = await a.complete(
        system="sys",
        messages=[{"role": "user", "content": "hi"}],
        model="claude-opus-4-7",
        max_tokens=512,
    )
    assert out == {
        "content": [{"type": "text", "text": "Hello world"}],
        "stop_reason": "end_turn",
        "input_tokens": 20,
        "output_tokens": 5,
        "model": "claude-opus-4-7",
    }
    assert fake.last_options is not None
    assert fake.last_options.system_prompt == "sys"
    assert fake.last_options.model == "claude-opus-4-7"


async def test_captures_tool_use_block_from_assistant_message(monkeypatch) -> None:
    # The SDK stream emits an AssistantMessage that includes a ToolUseBlock
    # (model decided to call one of the ARTEX-declared tools). The adapter
    # must surface it as an Anthropic tool_use content block, stop_reason
    # must become 'tool_use', and iteration must stop.
    fake = _fake_query_factory(
        [
            _Assistant(
                content=[
                    _Text(text="Checking it."),
                    _ToolUse(
                        id="toolu_captured",
                        name="mcp__artex__http_get",
                        input={"url": "https://example.test"},
                    ),
                ]
            ),
            _Result(usage={"input_tokens": 12, "output_tokens": 3}),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)

    a = ClaudeSdkAdapter()
    out = await a.complete(
        system="sys",
        messages=[{"role": "user", "content": "check it"}],
        model="claude-opus-4-7",
        max_tokens=512,
        tools=[
            {
                "name": "http_get",
                "description": "GET a URL",
                "input_schema": {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            }
        ],
    )

    assert out["stop_reason"] == "tool_use"
    # The MCP prefix is stripped so ARTEX sees its own tool name back.
    assert out["content"] == [
        {"type": "text", "text": "Checking it."},
        {
            "type": "tool_use",
            "id": "toolu_captured",
            "name": "http_get",
            "input": {"url": "https://example.test"},
        },
    ]
    # Tools were registered on the options.
    assert fake.last_options.mcp_servers is not None
    assert "artex" in fake.last_options.mcp_servers
    assert fake.last_options.allowed_tools == ["mcp__artex__http_get"]


async def test_no_tools_means_no_mcp_server_registered(monkeypatch) -> None:
    fake = _fake_query_factory(
        [
            _Assistant(content=[_Text(text="ok")]),
            _Result(usage={"input_tokens": 1, "output_tokens": 1}),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)
    a = ClaudeSdkAdapter()
    await a.complete(
        system="",
        messages=[{"role": "user", "content": "hi"}],
        model="m",
        max_tokens=10,
    )
    assert not fake.last_options.mcp_servers


async def test_cli_builtin_tools_are_disabled(monkeypatch) -> None:
    # Regression: if `tools` is not [], the Claude Code CLI built-ins stay
    # visible to the model. A live integration test caught the model picking
    # ToolSearch for a URL probe instead of the http_get MCP tool we had
    # declared. Lock the belt-and-braces in a unit test so a refactor can't
    # bring it back.
    fake = _fake_query_factory(
        [
            _Assistant(content=[_Text(text="ok")]),
            _Result(usage={"input_tokens": 1, "output_tokens": 1}),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)
    a = ClaudeSdkAdapter()
    await a.complete(
        system="", messages=[{"role": "user", "content": "hi"}], model="m", max_tokens=10
    )
    assert fake.last_options.tools == []

    # Also with ARTEX tools in play: built-ins still off; only the MCP
    # prefixed names are allowed.
    await a.complete(
        system="",
        messages=[{"role": "user", "content": "x"}],
        model="m",
        max_tokens=10,
        tools=[{"name": "http_get", "description": "x", "input_schema": {}}],
    )
    assert fake.last_options.tools == []
    assert fake.last_options.allowed_tools == ["mcp__artex__http_get"]


async def test_fallbacks_token_estimate_when_sdk_returns_no_usage(monkeypatch) -> None:
    fake = _fake_query_factory(
        [
            _Assistant(content=[_Text(text="short")]),
            _Result(usage=None),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)

    a = ClaudeSdkAdapter()
    out = await a.complete(
        system="sys",
        messages=[{"role": "user", "content": "hi"}],
        model="m",
        max_tokens=10,
    )
    assert out["input_tokens"] > 0  # estimated
    assert out["output_tokens"] > 0
    assert out["content"] == [{"type": "text", "text": "short"}]


async def test_raises_on_rate_limit_event(monkeypatch) -> None:
    fake = _fake_query_factory(
        [
            _RateLimitEvent(
                rate_limit_info=_RateLimitInfo(status="rejected", rate_limit_type="five_hour")
            )
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)

    a = ClaudeSdkAdapter()
    with pytest.raises(SubscriptionRateLimited):
        await a.complete(system="s", messages=[{"role": "user", "content": "x"}], model="m", max_tokens=10)


async def test_raises_on_rate_limit_terminal_result(monkeypatch) -> None:
    fake = _fake_query_factory(
        [
            _Result(terminal_reason="rate_limit", api_error_status=429),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)

    a = ClaudeSdkAdapter()
    with pytest.raises(SubscriptionRateLimited):
        await a.complete(system="s", messages=[{"role": "user", "content": "x"}], model="m", max_tokens=10)


async def test_builds_flat_prompt_with_role_markers(monkeypatch) -> None:
    fake = _fake_query_factory(
        [
            _Assistant(content=[_Text(text="ok")]),
            _Result(usage={"input_tokens": 1, "output_tokens": 1}),
        ]
    )
    monkeypatch.setattr("bridge.sdk_adapter_impl.query", fake)

    a = ClaudeSdkAdapter()
    await a.complete(
        system="sys",
        messages=[
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "assistant one"},
            {"role": "user", "content": "second"},
        ],
        model="m",
        max_tokens=10,
    )
    prompt = fake.last_prompt
    assert "first" in prompt
    assert "assistant one" in prompt
    assert "second" in prompt
    # last user message appears last in the prompt (positional semantics for the SDK)
    assert prompt.rfind("second") > prompt.rfind("first")
