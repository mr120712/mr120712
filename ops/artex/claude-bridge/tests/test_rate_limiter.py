# @polsia:user-owned — RED tests for the local rate limiter. Protects the
# user's Claude Code subscription window from an agent that would otherwise
# fan out hundreds of LLM calls per task. Two knobs: max RPS (token bucket)
# and max in-flight (semaphore).
from __future__ import annotations

import asyncio

import pytest

from bridge.rate_limit import RateLimiter, RateLimited


async def test_allows_under_the_rps_cap() -> None:
    lim = RateLimiter(max_rps=10.0, max_concurrency=4)
    async with lim.slot():
        pass
    async with lim.slot():
        pass  # should not block, well under 10 rps


async def test_rejects_over_rps() -> None:
    lim = RateLimiter(max_rps=1.0, max_concurrency=10)
    async with lim.slot():
        pass
    # second within the same second: must trip
    with pytest.raises(RateLimited):
        async with lim.slot():
            pass


async def test_concurrency_cap_blocks_once_full() -> None:
    lim = RateLimiter(max_rps=100.0, max_concurrency=1)

    ran: list[int] = []
    release = asyncio.Event()

    async def worker(i: int) -> None:
        async with lim.slot():
            ran.append(i)
            await release.wait()

    t1 = asyncio.create_task(worker(1))
    await asyncio.sleep(0.01)  # let t1 take the slot
    assert ran == [1]

    with pytest.raises(RateLimited):
        async with lim.slot():
            pass

    release.set()
    await t1


async def test_slot_released_after_use() -> None:
    lim = RateLimiter(max_rps=100.0, max_concurrency=1)
    async with lim.slot():
        pass
    # slot free again: this must not raise
    async with lim.slot():
        pass


async def test_disabled_limiter_passes_through() -> None:
    lim = RateLimiter(max_rps=0.0, max_concurrency=0)  # 0 == unlimited
    for _ in range(50):
        async with lim.slot():
            pass
