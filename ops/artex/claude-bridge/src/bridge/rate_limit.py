# @polsia:user-owned — local rate limiter for the bridge. Protects the user's
# Claude Code subscription window from being drained by an agent that fans out
# LLM calls without back-pressure. Two independent gates, BOTH blocking:
#   - a token bucket on requests-per-second (sleeps until a token is available)
#   - a semaphore on in-flight requests (awaits a slot)
# Neither refuses: both WAIT. That's the whole point — a 429 bubbling up to
# ARTEX stops an intent, which with unlimited budgets just means the task loses
# work for no gain. Blocking instead smooths the stream into whatever shape the
# subscription window will absorb. Setting either knob to 0 disables it.
#
# The legacy `RateLimited` exception is kept for API compatibility (older
# callers can still catch it) but is no longer raised by the slot path.
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator


class RateLimited(Exception):
    """Legacy name. The slot path no longer raises; it waits."""


class RateLimiter:
    def __init__(self, *, max_rps: float, max_concurrency: int) -> None:
        self._max_rps = max_rps
        self._max_concurrency = max_concurrency
        self._tokens: float = max_rps if max_rps > 0 else 0.0
        self._last_refill = time.monotonic()
        self._bucket_lock = asyncio.Lock()
        # Semaphore blocks acquirers past max_concurrency; disabled when 0.
        self._sem: asyncio.Semaphore | None = (
            asyncio.Semaphore(max_concurrency) if max_concurrency > 0 else None
        )

    async def _wait_for_token(self) -> None:
        """Token-bucket wait. Blocks until one token is available, then
        consumes it. Several callers racing for the same token are
        serialized by the bucket lock; each loops until it gets one."""
        if self._max_rps <= 0:
            return
        while True:
            async with self._bucket_lock:
                now = time.monotonic()
                elapsed = now - self._last_refill
                self._tokens = min(
                    self._max_rps, self._tokens + elapsed * self._max_rps
                )
                self._last_refill = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                # How long until we'd have 1 full token?
                deficit = 1 - self._tokens
                wait = deficit / self._max_rps
            # Sleep OUTSIDE the lock so other coroutines can refill their own
            # view of the bucket in the meantime.
            await asyncio.sleep(max(wait, 0.001))

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        await self._wait_for_token()
        if self._sem is not None:
            async with self._sem:
                yield
        else:
            yield
