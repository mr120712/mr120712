# @polsia:user-owned — RED tests for SSE streaming. Each SSE frame has the
# shape `event: <type>\ndata: <json>\n\n`; the Anthropic spec sequences them:
# message_start → (content_block_start → content_block_delta* →
# content_block_stop)+ → message_delta → message_stop.
#
# The bridge FAKE-streams: it collects the full adapter response first and
# then chunks it into SSE frames. ARTEX's Go client (per the researcher's
# report) parses the stream to update usage counters, so message_start must
# carry input_tokens and message_delta must carry the final output_tokens.
from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from bridge.app import build_app
from bridge.sdk_adapter import SdkAdapter


class StubAdapter(SdkAdapter):
    def __init__(self, result: dict[str, Any]) -> None:
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def complete(self, *, system, messages, model, max_tokens, tools=None):
        self.calls.append(
            {"system": system, "messages": messages, "model": model, "tools": tools}
        )
        return self.result


def _parse_sse(body: str) -> list[dict[str, Any]]:
    """Parse raw SSE body into a list of {event, data} dicts."""
    events: list[dict[str, Any]] = []
    for frame in body.split("\n\n"):
        if not frame.strip():
            continue
        event = None
        data_lines: list[str] = []
        for line in frame.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].strip())
        if event is None:
            continue
        data_raw = "\n".join(data_lines)
        try:
            data = json.loads(data_raw)
        except json.JSONDecodeError:
            data = {"_raw": data_raw}
        events.append({"event": event, "data": data})
    return events


def _body(**over):
    b = {
        "model": "claude-opus-4-7",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "ping"}],
        "stream": True,
    }
    b.update(over)
    return b


def test_stream_returns_text_event_stream_content_type() -> None:
    adapter = StubAdapter(
        {
            "content": [{"type": "text", "text": "pong"}],
            "stop_reason": "end_turn",
            "input_tokens": 10,
            "output_tokens": 2,
            "model": "claude-opus-4-7",
        }
    )
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")


def test_stream_emits_anthropic_text_sequence() -> None:
    adapter = StubAdapter(
        {
            "content": [{"type": "text", "text": "Hello world."}],
            "stop_reason": "end_turn",
            "input_tokens": 11,
            "output_tokens": 3,
            "model": "claude-opus-4-7",
        }
    )
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
    events = _parse_sse(res.text)
    types = [e["event"] for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "message_stop"
    assert "content_block_start" in types
    assert "content_block_delta" in types
    assert "content_block_stop" in types
    assert "message_delta" in types

    start = next(e for e in events if e["event"] == "message_start")
    assert start["data"]["type"] == "message_start"
    assert start["data"]["message"]["type"] == "message"
    assert start["data"]["message"]["role"] == "assistant"
    assert start["data"]["message"]["model"] == "claude-opus-4-7"
    assert start["data"]["message"]["usage"]["input_tokens"] == 11

    # Reassemble the text from text_delta frames.
    deltas = [
        e["data"]["delta"]["text"]
        for e in events
        if e["event"] == "content_block_delta"
        and e["data"]["delta"].get("type") == "text_delta"
    ]
    assert "".join(deltas) == "Hello world."

    msg_delta = next(e for e in events if e["event"] == "message_delta")
    assert msg_delta["data"]["delta"]["stop_reason"] == "end_turn"
    assert msg_delta["data"]["usage"]["output_tokens"] == 3


def test_stream_emits_tool_use_block_with_input_json_delta() -> None:
    tool_input = {"url": "https://example.test/health", "timeout": 10}
    adapter = StubAdapter(
        {
            "content": [
                {"type": "text", "text": "Calling it."},
                {
                    "type": "tool_use",
                    "id": "toolu_abc",
                    "name": "http_get",
                    "input": tool_input,
                },
            ],
            "stop_reason": "tool_use",
            "input_tokens": 20,
            "output_tokens": 7,
            "model": "claude-opus-4-7",
        }
    )
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
    events = _parse_sse(res.text)

    starts = [e for e in events if e["event"] == "content_block_start"]
    assert len(starts) == 2
    assert starts[0]["data"]["content_block"]["type"] == "text"
    tu_start = starts[1]
    assert tu_start["data"]["content_block"]["type"] == "tool_use"
    assert tu_start["data"]["content_block"]["id"] == "toolu_abc"
    assert tu_start["data"]["content_block"]["name"] == "http_get"
    # Per Anthropic spec, tool_use start carries empty input; the fields arrive
    # via input_json_delta frames.
    assert tu_start["data"]["content_block"]["input"] == {}

    json_deltas = [
        e["data"]["delta"]["partial_json"]
        for e in events
        if e["event"] == "content_block_delta"
        and e["data"]["delta"].get("type") == "input_json_delta"
    ]
    rebuilt = json.loads("".join(json_deltas))
    assert rebuilt == tool_input

    msg_delta = next(e for e in events if e["event"] == "message_delta")
    assert msg_delta["data"]["delta"]["stop_reason"] == "tool_use"


def test_stream_indexes_content_blocks_sequentially() -> None:
    adapter = StubAdapter(
        {
            "content": [
                {"type": "text", "text": "one"},
                {"type": "text", "text": "two"},
                {
                    "type": "tool_use",
                    "id": "toolu_x",
                    "name": "http_get",
                    "input": {"url": "x"},
                },
            ],
            "stop_reason": "tool_use",
            "input_tokens": 5,
            "output_tokens": 3,
            "model": "m",
        }
    )
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
    events = _parse_sse(res.text)
    starts = [e["data"]["index"] for e in events if e["event"] == "content_block_start"]
    stops = [e["data"]["index"] for e in events if e["event"] == "content_block_stop"]
    assert starts == [0, 1, 2]
    assert stops == [0, 1, 2]


def test_stream_rate_limit_emits_error_event_not_200_json() -> None:
    from bridge.errors import SubscriptionRateLimited

    class FailingAdapter(SdkAdapter):
        async def complete(self, *, system, messages, model, max_tokens, tools=None):
            raise SubscriptionRateLimited("5-hour window exhausted")

    app = build_app(adapter=FailingAdapter(), cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
    # Anthropic streams errors as HTTP 200 + `event: error` frames; the
    # client parses the body. Non-streamed errors stay HTTP 429.
    assert res.status_code == 200
    events = _parse_sse(res.text)
    err = [e for e in events if e["event"] == "error"]
    assert err, f"expected error event; got events: {[e['event'] for e in events]}"
    assert err[0]["data"]["error"]["type"] == "rate_limit_error"


def test_non_stream_request_still_returns_json() -> None:
    adapter = StubAdapter(
        {
            "content": [{"type": "text", "text": "hi"}],
            "stop_reason": "end_turn",
            "input_tokens": 1,
            "output_tokens": 1,
            "model": "m",
        }
    )
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post(
            "/v1/messages",
            json=_body(stream=False),
            headers={"x-api-key": "dummy"},
        )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    assert res.json()["type"] == "message"
