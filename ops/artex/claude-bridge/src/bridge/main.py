# @polsia:user-owned — the `python -m bridge.main` entrypoint. Reads env vars,
# wires the real Claude Agent SDK adapter + SQLite cache + rate limiter, and
# starts uvicorn.
from __future__ import annotations

import asyncio
import logging
import os

import uvicorn

from bridge.app import build_app
from bridge.cache import PromptCache
from bridge.rate_limit import RateLimiter
from bridge.sdk_adapter_impl import ClaudeSdkAdapter

log = logging.getLogger("artex-claude-bridge")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


async def _amain() -> None:
    logging.basicConfig(
        level=os.environ.get("BRIDGE_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    cache_path = os.environ.get("BRIDGE_CACHE_PATH", "/data/cache.sqlite")
    cache_ttl = _int("BRIDGE_CACHE_TTL_SECONDS", 3600)
    max_rps = _float("BRIDGE_MAX_RPS", 1.0)
    max_conc = _int("BRIDGE_MAX_CONCURRENCY", 2)
    port = _int("BRIDGE_PORT", 5000)
    host = os.environ.get("BRIDGE_HOST", "0.0.0.0")

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    cache = PromptCache(path=cache_path, ttl_seconds=cache_ttl)
    await cache.open()
    limiter = RateLimiter(max_rps=max_rps, max_concurrency=max_conc)
    adapter = ClaudeSdkAdapter()

    app = build_app(adapter=adapter, cache=cache, limiter=limiter)

    log.info(
        "bridge up: host=%s port=%d max_rps=%s max_concurrency=%d cache=%s ttl=%ds",
        host,
        port,
        max_rps,
        max_conc,
        cache_path,
        cache_ttl,
    )

    config = uvicorn.Config(app=app, host=host, port=port, log_level="info", access_log=True)
    server = uvicorn.Server(config)
    try:
        await server.serve()
    finally:
        await cache.close()


def main() -> None:
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
