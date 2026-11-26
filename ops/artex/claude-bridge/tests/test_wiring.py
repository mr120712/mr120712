# @polsia:user-owned — RED tests for how the route composes cache + limiter +
# adapter. Each collaborator is exercised through its real class (not another
# fake), so a regression where the wiring order changes would be caught here.
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from bridge.app import build_app
from bridge.cache import PromptCache
from bridge.rate_limit import RateLimiter
from bridge.sdk_adapter import SdkAdapter


class CountingAdapter(SdkAdapter):
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *, system, messages, model, max_tokens, tools=None):
        self.calls += 1
        return {
            "content": [{"type": "text", "text": f"reply-{self.calls}"}],
            "stop_reason": "end_turn",
            "input_tokens": 1,
            "output_tokens": 1,
            "model": model,
        }


@pytest.fixture
async def wired(tmp_path):
    adapter = CountingAdapter()
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    limiter = RateLimiter(max_rps=100.0, max_concurrency=10)
    app = build_app(adapter=adapter, cache=cache, limiter=limiter)
    try:
        yield app, adapter
    finally:
        await cache.close()


def _body(**over):
    b = {"model": "claude-opus-4-7", "max_tokens": 10, "messages": [{"role": "user", "content": "ping"}]}
    b.update(over)
    return b


async def test_second_identical_request_is_served_from_cache(wired) -> None:
    app, adapter = wired
    with TestClient(app) as c:
        r1 = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
        r2 = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["content"] == r2.json()["content"]
    assert adapter.calls == 1  # cache saved us one call


async def test_different_prompt_bypasses_cache(wired) -> None:
    app, adapter = wired
    with TestClient(app) as c:
        c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
        c.post(
            "/v1/messages",
            json=_body(messages=[{"role": "user", "content": "different"}]),
            headers={"x-api-key": "dummy"},
        )
    assert adapter.calls == 2


async def test_rate_limited_request_returns_429(tmp_path) -> None:
    adapter = CountingAdapter()
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=1.0, max_concurrency=10)
        app = build_app(adapter=adapter, cache=cache, limiter=limiter)
        with TestClient(app) as c:
            r1 = c.post(
                "/v1/messages",
                json=_body(messages=[{"role": "user", "content": "A"}]),
                headers={"x-api-key": "dummy"},
            )
            r2 = c.post(
                "/v1/messages",
                json=_body(messages=[{"role": "user", "content": "B"}]),
                headers={"x-api-key": "dummy"},
            )
        assert r1.status_code == 200
        assert r2.status_code == 429
        err = r2.json()
        assert err["error"]["type"] == "rate_limit_error"
    finally:
        await cache.close()
