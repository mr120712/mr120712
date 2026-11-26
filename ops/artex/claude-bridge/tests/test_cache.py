# @polsia:user-owned — RED tests for the SQLite prompt cache. Hits are keyed
# on a canonical hash of {system, messages, model, max_tokens} and store the
# normalized adapter result (text + usage). TTL expires rows; miss returns None.
from __future__ import annotations

import asyncio

import pytest

from bridge.cache import PromptCache


@pytest.fixture
async def cache(tmp_path) -> PromptCache:
    c = PromptCache(path=str(tmp_path / "cache.sqlite"), ttl_seconds=60)
    await c.open()
    try:
        yield c
    finally:
        await c.close()


async def test_miss_returns_none(cache: PromptCache) -> None:
    hit = await cache.get(
        system="s", messages=[{"role": "user", "content": "x"}], model="m", max_tokens=10
    )
    assert hit is None


async def test_set_then_hit(cache: PromptCache) -> None:
    value = {"text": "pong", "input_tokens": 1, "output_tokens": 2, "model": "m"}
    await cache.set(
        system="s",
        messages=[{"role": "user", "content": "x"}],
        model="m",
        max_tokens=10,
        value=value,
    )
    hit = await cache.get(
        system="s", messages=[{"role": "user", "content": "x"}], model="m", max_tokens=10
    )
    assert hit == value


async def test_different_messages_do_not_collide(cache: PromptCache) -> None:
    await cache.set(
        system="s",
        messages=[{"role": "user", "content": "A"}],
        model="m",
        max_tokens=10,
        value={"text": "a-ans", "input_tokens": 1, "output_tokens": 1, "model": "m"},
    )
    hit = await cache.get(
        system="s", messages=[{"role": "user", "content": "B"}], model="m", max_tokens=10
    )
    assert hit is None


async def test_different_system_do_not_collide(cache: PromptCache) -> None:
    await cache.set(
        system="s1",
        messages=[{"role": "user", "content": "x"}],
        model="m",
        max_tokens=10,
        value={"text": "ans", "input_tokens": 1, "output_tokens": 1, "model": "m"},
    )
    hit = await cache.get(
        system="s2", messages=[{"role": "user", "content": "x"}], model="m", max_tokens=10
    )
    assert hit is None


async def test_ttl_expires(tmp_path) -> None:
    c = PromptCache(path=str(tmp_path / "c.sqlite"), ttl_seconds=0)  # instant expiry
    await c.open()
    try:
        await c.set(
            system="s",
            messages=[{"role": "user", "content": "x"}],
            model="m",
            max_tokens=10,
            value={"text": "pong", "input_tokens": 1, "output_tokens": 1, "model": "m"},
        )
        await asyncio.sleep(0.01)
        hit = await c.get(
            system="s", messages=[{"role": "user", "content": "x"}], model="m", max_tokens=10
        )
        assert hit is None
    finally:
        await c.close()
