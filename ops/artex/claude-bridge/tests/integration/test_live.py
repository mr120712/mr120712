# @polsia:user-owned — live integration tests. These spawn the REAL `claude`
# CLI via claude_agent_sdk.query() and consume the user's Claude Code
# subscription quota. Skipped unless BOTH gates are satisfied:
#
#   - env ARTEX_BRIDGE_LIVE_TESTS=1
#   - `claude` CLI on PATH and authenticated (`claude login` completed)
#
# The suite is excluded from the default pytest run (see pyproject.toml's
# `-m "not integration"`). Opt in explicitly:
#
#   ARTEX_BRIDGE_LIVE_TESTS=1 pytest -m integration
#
# Each test uses haiku + tiny max_tokens to minimize cost; a full run is a
# few dozen tokens. Expect ~10s wall time per test (CLI cold start + call).
from __future__ import annotations

import json
import os
import shutil

import pytest
from fastapi.testclient import TestClient

from bridge.app import build_app
from bridge.sdk_adapter_impl import ClaudeSdkAdapter

pytestmark = pytest.mark.integration

_LIVE_ENV = os.environ.get("ARTEX_BRIDGE_LIVE_TESTS") == "1"
_CLAUDE_CLI = shutil.which("claude")

_requires_live = pytest.mark.skipif(
    not (_LIVE_ENV and _CLAUDE_CLI),
    reason=(
        "live test skipped; set ARTEX_BRIDGE_LIVE_TESTS=1 and ensure the "
        "`claude` CLI is on PATH and logged in (`claude login`)"
    ),
)

# Cheap model for every live test. Override with ARTEX_BRIDGE_LIVE_MODEL to
# run against a different account tier.
LIVE_MODEL = os.environ.get("ARTEX_BRIDGE_LIVE_MODEL", "claude-haiku-4-5")


@_requires_live
async def test_live_adapter_text_only_completion() -> None:
    adapter = ClaudeSdkAdapter()
    out = await adapter.complete(
        system='Reply with exactly the single word READY and nothing else.',
        messages=[{"role": "user", "content": "say READY"}],
        model=LIVE_MODEL,
        max_tokens=50,
    )
    assert out["stop_reason"] == "end_turn"
    text = "".join(b["text"] for b in out["content"] if b.get("type") == "text")
    assert "READY" in text.upper(), f"unexpected response: {text!r}"
    # Usage must be populated from the live SDK (not the estimator fallback).
    assert out["input_tokens"] > 0
    assert out["output_tokens"] > 0


@_requires_live
async def test_live_adapter_tool_use_decision() -> None:
    adapter = ClaudeSdkAdapter()
    out = await adapter.complete(
        system=(
            "You are a probe. When asked to fetch a URL, call the http_get "
            "tool with the exact URL. Do not reply with prose; call the tool."
        ),
        messages=[
            {"role": "user", "content": "Fetch https://example.test/health"},
        ],
        model=LIVE_MODEL,
        max_tokens=200,
        tools=[
            {
                "name": "http_get",
                "description": "GET a URL and return the response headers + body",
                "input_schema": {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            }
        ],
    )
    tool_uses = [b for b in out["content"] if b.get("type") == "tool_use"]
    assert tool_uses, (
        f"expected at least one tool_use; got content={out['content']!r}"
    )
    tu = tool_uses[0]
    # Prefix must be stripped before reaching the client.
    assert tu["name"] == "http_get"
    assert "url" in tu["input"]
    assert "example.test" in tu["input"]["url"]
    assert out["stop_reason"] == "tool_use"


@_requires_live
async def test_live_http_bridge_text_roundtrip() -> None:
    """Drive the full FastAPI route end-to-end against the live CLI."""
    adapter = ClaudeSdkAdapter()
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post(
            "/v1/messages",
            headers={"x-api-key": "live-integration", "anthropic-version": "2023-06-01"},
            json={
                "model": LIVE_MODEL,
                "max_tokens": 50,
                "system": "Reply with exactly READY.",
                "messages": [{"role": "user", "content": "go"}],
            },
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["type"] == "message"
    assert body["role"] == "assistant"
    assert body["stop_reason"] == "end_turn"
    text = "".join(b["text"] for b in body["content"] if b.get("type") == "text")
    assert "READY" in text.upper()


@_requires_live
async def test_live_http_bridge_stream_roundtrip() -> None:
    """Drive the SSE stream end-to-end against the live CLI."""
    adapter = ClaudeSdkAdapter()
    app = build_app(adapter=adapter, cache=None, limiter=None)
    with TestClient(app) as c:
        res = c.post(
            "/v1/messages",
            headers={"x-api-key": "live-integration", "anthropic-version": "2023-06-01"},
            json={
                "model": LIVE_MODEL,
                "max_tokens": 50,
                "stream": True,
                "system": "Reply with exactly READY.",
                "messages": [{"role": "user", "content": "go"}],
            },
        )
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/event-stream")
    # Re-parse the SSE body and check message_stop lands.
    events: list[dict] = []
    for frame in res.text.split("\n\n"):
        if not frame.strip():
            continue
        event, data = None, None
        for line in frame.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                try:
                    data = json.loads(line[len("data:"):].strip())
                except json.JSONDecodeError:
                    data = None
        if event is not None:
            events.append({"event": event, "data": data})
    types = [e["event"] for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "message_stop"
    # Reassemble text and confirm the model's reply came through.
    deltas = [
        e["data"]["delta"]["text"]
        for e in events
        if e["event"] == "content_block_delta"
        and e["data"]
        and e["data"].get("delta", {}).get("type") == "text_delta"
    ]
    assert "READY" in "".join(deltas).upper()
