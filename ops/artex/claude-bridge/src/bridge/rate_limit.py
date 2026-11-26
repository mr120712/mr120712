# @polsia:user-owned — local rate limiter for the bridge. Protects the user's
# Claude Code subscription window from being drained by an agent that fans out
# LLM calls without back-pressure. Two independent gates:
#   - a token bucket on requests-per-second
#   - a semaphore on in-flight requests
# Both signal failure the same way: `RateLimited`, which the route handler maps
# to a 429 with `rate_limit_error`. Setting either knob to 0 disables it.
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator


class RateLimited(Exception):
    pass


class RateLimiter:
    def __init__(self, *, max_rps: float, max_concurrency: int) -> None:
        self._max_rps = max_rps
        self._max_concurrency = max_concurrency
        self._tokens: float = max_rps if max_rps > 0 else 0.0
        self._last_refill = time.monotonic()
        # Allow full starting concurrency; use a counter to try-acquire without blocking.
        self._in_flight = 0
        self._lock = asyncio.Lock()

    async def _try_take_token(self) -> None:
        if self._max_rps <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._tokens = min(self._max_rps, self._tokens + elapsed * self._max_rps)
            self._last_refill = now
            if self._tokens < 1:
                raise RateLimited(
                    f"local bridge rate limit: more than {self._max_rps} req/s"
                )
            self._tokens -= 1

    async def _try_take_slot(self) -> None:
        if self._max_concurrency <= 0:
            return
        async with self._lock:
            if self._in_flight >= self._max_concurrency:
                raise RateLimited(
                    f"local bridge concurrency limit: {self._max_concurrency} in flight"
                )
            self._in_flight += 1

    async def _release_slot(self) -> None:
        if self._max_concurrency <= 0:
            return
        async with self._lock:
            self._in_flight = max(0, self._in_flight - 1)

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        await self._try_take_token()
        await self._try_take_slot()
        try:
            yield
        finally:
            await self._release_slot()
