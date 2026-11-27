# @polsia:user-owned — tests for the local rate limiter. Contract: BOTH knobs
# BLOCK rather than refuse. Over-rps callers sleep until a bucket token is
# available; over-concurrency callers await a semaphore slot. The limiter
# never surfaces a rate-limit error to the route; a 429 reaching ARTEX would
# just waste an intent.
from __future__ import annotations

import asyncio
import time

import pytest

from bridge.rate_limit import RateLimiter


async def test_allows_under_the_rps_cap() -> None:
    lim = RateLimiter(max_rps=10.0, max_concurrency=4)
    async with lim.slot():
        pass
    async with lim.slot():
        pass  # should not block, well under 10 rps


async def test_over_rps_waits_instead_of_refusing() -> None:
    # max_rps=2 -> bucket starts full with 2.0 tokens. Three back-to-back
    # calls spend 1, 1, and the third must WAIT ~0.5s for a refill.
    lim = RateLimiter(max_rps=2.0, max_concurrency=10)

    t0 = time.monotonic()
    for _ in range(3):
        async with lim.slot():
            pass
    elapsed = time.monotonic() - t0
    # Allow slack for scheduling; the point is we waited, not refused.
    assert 0.3 <= elapsed <= 2.0, f"expected ~0.5s wait, got {elapsed:.3f}s"


async def test_concurrency_cap_blocks_until_slot_free() -> None:
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

    # t2 enters slot context and MUST block on the semaphore, not raise.
    t2_entered = asyncio.Event()

    async def worker2() -> None:
        async with lim.slot():
            t2_entered.set()
            ran.append(2)

    t2 = asyncio.create_task(worker2())
    await asyncio.sleep(0.05)
    assert not t2_entered.is_set(), "t2 should still be waiting"

    release.set()
    await t1
    await t2
    assert ran == [1, 2]


async def test_slot_released_after_use() -> None:
    lim = RateLimiter(max_rps=100.0, max_concurrency=1)
    async with lim.slot():
        pass
    async with lim.slot():
        pass  # must not deadlock


async def test_disabled_limiter_passes_through() -> None:
    lim = RateLimiter(max_rps=0.0, max_concurrency=0)  # 0 == unlimited
    for _ in range(50):
        async with lim.slot():
            pass
