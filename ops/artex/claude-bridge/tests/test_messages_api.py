# @polsia:user-owned — RED tests for /v1/messages. These describe the exact
# Anthropic-compat request/response shape ARTEX (Go client, hand-rolls the HTTP
# call per the researcher's report) will exchange with the bridge. The SDK is
# mocked here; the point of these tests is wire shape, not SDK integration.
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from bridge.app import build_app
from bridge.sdk_adapter import SdkAdapter


class FakeAdapter(SdkAdapter):
    """Collects calls and returns canned responses; replaces the real SDK in tests."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.text_to_return = "Pong from Claude."
        self.input_tokens = 42
        self.output_tokens = 7
        self.raise_rate_limit = False
        self.content_blocks: list[dict[str, Any]] | None = None
        self.stop_reason = "end_turn"

    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "system": system,
                "messages": messages,
                "model": model,
                "max_tokens": max_tokens,
                "tools": tools,
            }
        )
        if self.raise_rate_limit:
            from bridge.errors import SubscriptionRateLimited

            raise SubscriptionRateLimited("subscription window exhausted")
        content = self.content_blocks
        if content is None:
            content = [{"type": "text", "text": self.text_to_return}]
        return {
            "content": content,
            "stop_reason": self.stop_reason,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "model": model or "claude-opus-4-7",
        }


@pytest.fixture
def adapter() -> FakeAdapter:
    return FakeAdapter()


@pytest.fixture
def client(adapter: FakeAdapter) -> TestClient:
    app = build_app(adapter=adapter, cache=None, limiter=None)
    return TestClient(app)


def _basic_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "model": "claude-opus-4-7",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Ping?"}],
    }
    body.update(overrides)
    return body


def test_returns_200_with_anthropic_shape(client: TestClient, adapter: FakeAdapter) -> None:
    res = client.post("/v1/messages", json=_basic_body(), headers={"x-api-key": "dummy"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["type"] == "message"
    assert body["role"] == "assistant"
    assert body["model"] == "claude-opus-4-7"
    assert body["stop_reason"] == "end_turn"
    assert body["content"] == [{"type": "text", "text": "Pong from Claude."}]
    assert body["usage"] == {"input_tokens": 42, "output_tokens": 7}
    assert body["id"].startswith("msg_")


def test_adapter_called_with_tools_none_when_absent(
    client: TestClient, adapter: FakeAdapter
) -> None:
    client.post("/v1/messages", json=_basic_body(), headers={"x-api-key": "dummy"})
    assert adapter.calls[0]["tools"] is None


def test_accepts_system_as_string(client: TestClient, adapter: FakeAdapter) -> None:
    client.post(
        "/v1/messages",
        json=_basic_body(system="You are a pentesting planner."),
        headers={"x-api-key": "dummy"},
    )
    assert adapter.calls[0]["system"] == "You are a pentesting planner."


def test_accepts_system_as_block_array(client: TestClient, adapter: FakeAdapter) -> None:
    # ARTEX's Go client sends `system` as an array of text blocks per the report.
    client.post(
        "/v1/messages",
        json=_basic_body(
            system=[
                {"type": "text", "text": "You are ARTEX planner."},
                {"type": "text", "text": "Stay in scope."},
            ],
        ),
        headers={"x-api-key": "dummy"},
    )
    assert adapter.calls[0]["system"] == "You are ARTEX planner.\n\nStay in scope."


def test_accepts_message_content_as_string_or_block_array(
    client: TestClient, adapter: FakeAdapter
) -> None:
    client.post(
        "/v1/messages",
        json=_basic_body(
            messages=[
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "text", "text": "hi back"}]},
                {"role": "user", "content": [{"type": "text", "text": "and again"}]},
            ],
        ),
        headers={"x-api-key": "dummy"},
    )
    assert adapter.calls[0]["messages"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi back"},
        {"role": "user", "content": "and again"},
    ]


def test_tools_array_forwarded_to_adapter(client: TestClient, adapter: FakeAdapter) -> None:
    tools = [
        {
            "name": "http_get",
            "description": "GET a URL",
            "input_schema": {"type": "object", "properties": {"url": {"type": "string"}}},
        }
    ]
    client.post("/v1/messages", json=_basic_body(tools=tools), headers={"x-api-key": "dummy"})
    assert adapter.calls[0]["tools"] == tools


def test_tool_use_response_is_returned_verbatim(
    client: TestClient, adapter: FakeAdapter
) -> None:
    adapter.content_blocks = [
        {"type": "text", "text": "I'll check that URL."},
        {
            "type": "tool_use",
            "id": "toolu_abc123",
            "name": "http_get",
            "input": {"url": "https://example.test/health"},
        },
    ]
    adapter.stop_reason = "tool_use"

    tools = [{"name": "http_get", "description": "x", "input_schema": {"type": "object"}}]
    res = client.post(
        "/v1/messages", json=_basic_body(tools=tools), headers={"x-api-key": "dummy"}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["stop_reason"] == "tool_use"
    assert body["content"] == [
        {"type": "text", "text": "I'll check that URL."},
        {
            "type": "tool_use",
            "id": "toolu_abc123",
            "name": "http_get",
            "input": {"url": "https://example.test/health"},
        },
    ]


def test_tool_result_in_inbound_messages_passes_through(
    client: TestClient, adapter: FakeAdapter
) -> None:
    # ARTEX's follow-up request carries the prior tool_use + tool_result.
    body = _basic_body(
        tools=[{"name": "http_get", "description": "x", "input_schema": {"type": "object"}}],
        messages=[
            {"role": "user", "content": "check example.test"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Calling http_get."},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "http_get",
                        "input": {"url": "https://example.test"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "HTTP 200\nserver: nginx",
                    }
                ],
            },
        ],
    )
    res = client.post("/v1/messages", json=body, headers={"x-api-key": "dummy"})
    assert res.status_code == 200, res.text
    forwarded = adapter.calls[0]["messages"]
    # The bridge preserves role sequence; adapter sees the tool_result content.
    assert len(forwarded) == 3
    assert forwarded[0]["role"] == "user"
    assert forwarded[1]["role"] == "assistant"
    assert forwarded[2]["role"] == "user"
    # Tool_result content is preserved verbatim in a structured form so the
    # adapter can decide how to re-inject it into the SDK prompt.
    last = forwarded[2]
    assert "HTTP 200" in last["content"]
    assert "toolu_1" in last["content"]


def test_missing_required_field_is_400(client: TestClient) -> None:
    res = client.post(
        "/v1/messages",
        json={"model": "claude-opus-4-7"},  # no messages, no max_tokens
        headers={"x-api-key": "dummy"},
    )
    assert res.status_code == 400
    err = res.json()
    assert err["type"] == "error"
    assert err["error"]["type"] == "invalid_request_error"


def test_streaming_requested_is_rejected_501(client: TestClient) -> None:
    body = _basic_body(stream=True)
    res = client.post("/v1/messages", json=body, headers={"x-api-key": "dummy"})
    assert res.status_code == 501
    err = res.json()
    assert err["error"]["type"] == "not_implemented"
    assert "stream" in err["error"]["message"].lower()


def test_rate_limited_returns_429(client: TestClient, adapter: FakeAdapter) -> None:
    adapter.raise_rate_limit = True
    res = client.post("/v1/messages", json=_basic_body(), headers={"x-api-key": "dummy"})
    assert res.status_code == 429
    err = res.json()
    assert err["type"] == "error"
    assert err["error"]["type"] == "rate_limit_error"


def test_health_endpoint(client: TestClient) -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["service"] == "artex-claude-bridge"


def test_ignores_x_api_key_value(client: TestClient, adapter: FakeAdapter) -> None:
    # Any non-empty x-api-key is accepted. ARTEX .env can carry a dummy value.
    res = client.post(
        "/v1/messages",
        json=_basic_body(),
        headers={"x-api-key": "sk-anything-goes-here"},
    )
    assert res.status_code == 200


def test_ignores_thinking_and_output_config_extensions(
    client: TestClient, adapter: FakeAdapter
) -> None:
    # Per the researcher's report, ARTEX's norma client sends non-standard
    # `thinking` and `output_config` fields. The bridge accepts and ignores.
    body = _basic_body(
        thinking={"type": "enabled", "budget_tokens": 2048},
        output_config={"effort": "medium"},
    )
    res = client.post("/v1/messages", json=body, headers={"x-api-key": "dummy"})
    assert res.status_code == 200, res.text


def test_max_tokens_is_forwarded(client: TestClient, adapter: FakeAdapter) -> None:
    client.post("/v1/messages", json=_basic_body(max_tokens=4096), headers={"x-api-key": "dummy"})
    assert adapter.calls[0]["max_tokens"] == 4096
