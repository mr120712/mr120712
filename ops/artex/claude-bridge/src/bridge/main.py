# @polsia:user-owned — the `python -m bridge.main` entrypoint. Reads env vars,
# wires the real Claude Agent SDK adapter + SQLite cache + rate limiter, and
# starts uvicorn.
from __future__ import annotations

import asyncio
import logging
import os

import uvicorn

from bridge.anthropic_fallback import AnthropicFallbackAdapter
from bridge.app import UpstreamRetry, build_app
from bridge.cache import PromptCache
from bridge.openai_fallback import OpenAIFallbackAdapter
from bridge.rate_limit import RateLimiter
from bridge.sdk_adapter import SdkAdapter
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
    # Default: 0.5 rps serial. Tighter than the old (1 rps, 2 in-flight) so
    # the subscription window never gets near rejection. Back-pressure is a
    # BLOCKING wait inside the slot, not a 429 to ARTEX.
    max_rps = _float("BRIDGE_MAX_RPS", 0.5)
    max_conc = _int("BRIDGE_MAX_CONCURRENCY", 1)
    # On an upstream rate_limit (the Claude Code subscription actually
    # rejecting), retry with exp backoff instead of surfacing 429 to ARTEX.
    # attempts=10, base=5s, cap=60s → up to ~5 min of retries riding out a
    # typical subscription cooldown. After that we DO return 429 so ARTEX
    # can decide; with unlimited budgets it just retries.
    retry_attempts = _int("BRIDGE_UPSTREAM_RETRY_ATTEMPTS", 10)
    retry_base = _float("BRIDGE_UPSTREAM_RETRY_BASE_SECONDS", 5.0)
    retry_cap = _float("BRIDGE_UPSTREAM_RETRY_CAP_SECONDS", 60.0)
    # Cap on a single wait-until-reset sleep. When the SDK tells us the
    # window resets in more than this many seconds (e.g. a seven_day
    # window), fall back to exp backoff instead of hanging the request.
    # Default 6h rides out a five_hour window; raise if you're willing
    # to hang on seven_day windows.
    reset_wait_cap = _float("BRIDGE_RESET_WAIT_CAP_SECONDS", 6 * 60 * 60)
    port = _int("BRIDGE_PORT", 5000)
    host = os.environ.get("BRIDGE_HOST", "0.0.0.0")

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    cache = PromptCache(path=cache_path, ttl_seconds=cache_ttl)
    await cache.open()
    limiter = RateLimiter(max_rps=max_rps, max_concurrency=max_conc)
    upstream_retry = UpstreamRetry(
        attempts=retry_attempts,
        base_seconds=retry_base,
        cap_seconds=retry_cap,
        reset_wait_cap_seconds=reset_wait_cap,
    )
    adapter = ClaudeSdkAdapter()

    # Build the fallback chain. Order matters: the route handler tries each
    # in turn on the first SubscriptionRateLimited from the primary, uses
    # the first one that answers, and only falls back to wait-until-reset
    # if ALL links in the chain are also rate-limited or misconfigured.
    #
    # Each adapter's key lives only in process env; nothing is logged.
    fallbacks: list[SdkAdapter] = []

    omniroute_key = os.environ.get("OMNIROUTE_API_KEY", "").strip()
    if omniroute_key:
        fallbacks.append(
            OpenAIFallbackAdapter(
                name="omniroute",
                api_key=omniroute_key,
                base_url=os.environ.get("OMNIROUTE_BASE_URL", ""),
                model_override=os.environ.get("OMNIROUTE_MODEL", "").strip() or None,
                timeout_seconds=_float("OMNIROUTE_TIMEOUT_SECONDS", 300.0),
                auth_scheme=os.environ.get("OMNIROUTE_AUTH_SCHEME", "Bearer"),
                chat_completions_path=os.environ.get(
                    "OMNIROUTE_PATH", "/v1/chat/completions"
                ),
            )
        )

    freellm_key = os.environ.get("FREELLMAPI_API_KEY", "").strip()
    if freellm_key:
        fallbacks.append(
            OpenAIFallbackAdapter(
                name="freellmapi",
                api_key=freellm_key,
                base_url=os.environ.get("FREELLMAPI_BASE_URL", ""),
                model_override=os.environ.get("FREELLMAPI_MODEL", "").strip() or None,
                timeout_seconds=_float("FREELLMAPI_TIMEOUT_SECONDS", 300.0),
                auth_scheme=os.environ.get("FREELLMAPI_AUTH_SCHEME", "Bearer"),
                chat_completions_path=os.environ.get(
                    "FREELLMAPI_PATH", "/v1/chat/completions"
                ),
            )
        )

    # Direct OpenAI API. Default model is gpt-5-codex -- a coding/tool-use
    # specialized model better suited to ARTEX's workload than plain GPT-5.
    # Override via OPENAI_MODEL in .env if you want something else (e.g.
    # gpt-5, gpt-5-mini, gpt-4.1, o-series).
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        fallbacks.append(
            OpenAIFallbackAdapter(
                name="openai",
                api_key=openai_key,
                base_url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com"),
                model_override=os.environ.get("OPENAI_MODEL", "").strip() or "gpt-5-codex",
                timeout_seconds=_float("OPENAI_TIMEOUT_SECONDS", 300.0),
                auth_scheme=os.environ.get("OPENAI_AUTH_SCHEME", "Bearer"),
                chat_completions_path=os.environ.get(
                    "OPENAI_PATH", "/v1/chat/completions"
                ),
            )
        )

    anthropic_fallback_key = os.environ.get("ANTHROPIC_FALLBACK_API_KEY", "").strip()
    if anthropic_fallback_key:
        fallbacks.append(
            AnthropicFallbackAdapter(
                api_key=anthropic_fallback_key,
                base_url=os.environ.get(
                    "ANTHROPIC_FALLBACK_BASE_URL", "https://api.anthropic.com"
                ),
                timeout_seconds=_float("ANTHROPIC_FALLBACK_TIMEOUT_SECONDS", 300.0),
            )
        )

    app = build_app(
        adapter=adapter,
        cache=cache,
        limiter=limiter,
        upstream_retry=upstream_retry,
        fallback_adapters=fallbacks,
    )

    fb_names = ",".join(getattr(f, "name", type(f).__name__) for f in fallbacks) or "off"
    log.info(
        "bridge up: host=%s port=%d max_rps=%s max_concurrency=%d "
        "retry_attempts=%d retry_base=%.1fs retry_cap=%.1fs "
        "reset_wait_cap=%.0fs fallback_chain=[%s] cache=%s ttl=%ds",
        host,
        port,
        max_rps,
        max_conc,
        retry_attempts,
        retry_base,
        retry_cap,
        reset_wait_cap,
        fb_names,
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
