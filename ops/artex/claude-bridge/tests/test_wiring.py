# @polsia:user-owned — RED tests for how the route composes cache + limiter +
# adapter. Each collaborator is exercised through its real class (not another
# fake), so a regression where the wiring order changes would be caught here.
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from bridge.app import UpstreamRetry, build_app
from bridge.cache import PromptCache
from bridge.errors import SubscriptionRateLimited
from bridge.rate_limit import RateLimiter
from bridge.sdk_adapter import SdkAdapter


class CountingAdapter(SdkAdapter):
    def __init__(self) -> None:
        self.calls = 0
        self.rate_limit_before: int = 0  # raise this many times, then succeed

    async def complete(self, *, system, messages, model, max_tokens, tools=None):
        self.calls += 1
        if self.calls <= self.rate_limit_before:
            raise SubscriptionRateLimited(f"synthetic rl #{self.calls}")
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


async def test_local_rate_limit_blocks_but_eventually_succeeds(tmp_path) -> None:
    # max_rps=1 -> bucket starts with 1 token. First call drains it; second
    # call must WAIT ~1s for a refill, then succeed. Never surfaces 429.
    import time

    adapter = CountingAdapter()
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=1.0, max_concurrency=10)
        app = build_app(adapter=adapter, cache=cache, limiter=limiter)
        with TestClient(app) as c:
            t0 = time.monotonic()
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
            elapsed = time.monotonic() - t0
        assert r1.status_code == 200
        assert r2.status_code == 200, r2.json()
        assert 0.8 <= elapsed <= 3.0, f"expected the second call to wait ~1s, got {elapsed:.3f}s"
    finally:
        await cache.close()


async def test_upstream_rate_limit_retries_then_succeeds(tmp_path) -> None:
    # Adapter raises SubscriptionRateLimited twice, then succeeds. With the
    # retry policy (base_seconds tiny for the test) the route rides through
    # both and returns 200. ARTEX never sees a 429.
    adapter = CountingAdapter()
    adapter.rate_limit_before = 2  # calls #1 and #2 raise; #3 succeeds
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=0.0, max_concurrency=0)
        retry = UpstreamRetry(attempts=5, base_seconds=0.01, cap_seconds=0.05)
        app = build_app(adapter=adapter, cache=cache, limiter=limiter, upstream_retry=retry)
        with TestClient(app) as c:
            r = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
        assert r.status_code == 200, r.json()
        assert adapter.calls == 3
        assert r.json()["content"][0]["text"] == "reply-3"
    finally:
        await cache.close()


async def test_upstream_rate_limit_waits_until_resets_at(tmp_path) -> None:
    # Adapter raises once with a resets_at ~0.3s away, then succeeds. The
    # route must honor the honest-wait path (not exp backoff) and the second
    # attempt lands immediately after the window opens.
    import time

    class ResetsAdapter(SdkAdapter):
        def __init__(self) -> None:
            self.calls = 0

        async def complete(self, *, system, messages, model, max_tokens, tools=None):
            self.calls += 1
            if self.calls == 1:
                raise SubscriptionRateLimited(
                    "five_hour hit",
                    resets_at=int(time.time()) + 1,  # ~1s in the future
                    rate_limit_type="five_hour",
                )
            return {
                "content": [{"type": "text", "text": f"reply-{self.calls}"}],
                "stop_reason": "end_turn",
                "input_tokens": 1,
                "output_tokens": 1,
                "model": model,
            }

    adapter = ResetsAdapter()
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=0.0, max_concurrency=0)
        # Huge base_seconds so if exp backoff DID fire, the test would time
        # out. Reset-wait must prefer resets_at.
        retry = UpstreamRetry(
            attempts=3,
            base_seconds=600.0,
            cap_seconds=600.0,
            reset_wait_cap_seconds=30.0,
            reset_wait_jitter_seconds=0.1,
        )
        app = build_app(adapter=adapter, cache=cache, limiter=limiter, upstream_retry=retry)
        with TestClient(app) as c:
            t0 = time.monotonic()
            r = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
            elapsed = time.monotonic() - t0
        assert r.status_code == 200, r.json()
        assert adapter.calls == 2
        # Should have waited ~1s, not 600s.
        assert 0.5 <= elapsed <= 5.0, f"expected ~1s honest wait, got {elapsed:.3f}s"
    finally:
        await cache.close()


async def test_resets_at_beyond_cap_falls_back_to_backoff(tmp_path) -> None:
    # resets_at says 1 hour out, but cap is 0.2s. Route must fall through
    # to exp backoff instead of hanging for an hour.
    import time

    class FarResetsAdapter(SdkAdapter):
        def __init__(self) -> None:
            self.calls = 0

        async def complete(self, *, system, messages, model, max_tokens, tools=None):
            self.calls += 1
            if self.calls <= 1:
                raise SubscriptionRateLimited(
                    "seven_day hit",
                    resets_at=int(time.time()) + 3600,
                    rate_limit_type="seven_day",
                )
            return {
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn",
                "input_tokens": 1, "output_tokens": 1, "model": model,
            }

    adapter = FarResetsAdapter()
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=0.0, max_concurrency=0)
        retry = UpstreamRetry(
            attempts=3,
            base_seconds=0.05,  # tiny backoff so test is fast
            cap_seconds=0.1,
            reset_wait_cap_seconds=1.0,  # resets_at 3600s > 1s cap
        )
        app = build_app(adapter=adapter, cache=cache, limiter=limiter, upstream_retry=retry)
        with TestClient(app) as c:
            t0 = time.monotonic()
            r = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
            elapsed = time.monotonic() - t0
        assert r.status_code == 200, r.json()
        assert adapter.calls == 2
        # Backoff path: ~0.05s, not an hour.
        assert elapsed < 1.0, f"should have taken backoff, got {elapsed:.3f}s"
    finally:
        await cache.close()


async def test_fallback_adapter_takes_over_on_rate_limit(tmp_path) -> None:
    # Primary adapter rate-limits; a fallback adapter is wired. The route
    # must hop to the fallback immediately (no sleep), return its result,
    # and never raise.
    class FallbackCapture(SdkAdapter):
        def __init__(self) -> None:
            self.calls = 0

        async def complete(self, *, system, messages, model, max_tokens, tools=None):
            self.calls += 1
            return {
                "content": [{"type": "text", "text": "from-fallback"}],
                "stop_reason": "end_turn",
                "input_tokens": 5,
                "output_tokens": 3,
                "model": "claude-fallback",
            }

    primary = CountingAdapter()
    primary.rate_limit_before = 9999  # always rate-limited
    fallback = FallbackCapture()
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=0.0, max_concurrency=0)
        # Massive backoff so if we WAITED at all, the test would time out.
        retry = UpstreamRetry(attempts=3, base_seconds=600.0, cap_seconds=600.0)
        app = build_app(
            adapter=primary,
            cache=cache,
            limiter=limiter,
            upstream_retry=retry,
            fallback_adapter=fallback,
        )
        with TestClient(app) as c:
            r = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
        assert r.status_code == 200, r.json()
        body = r.json()
        assert body["content"][0]["text"] == "from-fallback"
        assert body["model"] == "claude-fallback"
        assert primary.calls == 1  # tried primary once, immediately fell through
        assert fallback.calls == 1
    finally:
        await cache.close()


async def test_upstream_rate_limit_exhausts_retries_returns_429(tmp_path) -> None:
    # Adapter always raises. After `attempts` tries the route gives up and
    # returns 429 with Anthropic-shape error body.
    adapter = CountingAdapter()
    adapter.rate_limit_before = 9999  # never succeed
    cache = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=60)
    await cache.open()
    try:
        limiter = RateLimiter(max_rps=0.0, max_concurrency=0)
        retry = UpstreamRetry(attempts=3, base_seconds=0.01, cap_seconds=0.05)
        app = build_app(adapter=adapter, cache=cache, limiter=limiter, upstream_retry=retry)
        with TestClient(app) as c:
            r = c.post("/v1/messages", json=_body(), headers={"x-api-key": "dummy"})
        assert r.status_code == 429
        err = r.json()
        assert err["error"]["type"] == "rate_limit_error"
        assert adapter.calls == 3
    finally:
        await cache.close()
