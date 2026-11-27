# @polsia:user-owned — FastAPI app factory. Keep the route thin; all business
# logic (SDK call, cache, rate limit) lives behind injected collaborators so
# tests can run the HTTP surface against fakes.
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from bridge.cache import PromptCache
from bridge.errors import SubscriptionRateLimited
from bridge.rate_limit import RateLimiter
from bridge.schema import MessagesRequest, normalize_messages, normalize_system
from bridge.sdk_adapter import SdkAdapter
from bridge.sse import stream_error, stream_result

log = logging.getLogger("artex-claude-bridge")


@dataclass(frozen=True)
class UpstreamRetry:
    """Policy for upstream SubscriptionRateLimited.

    Two layers of back-off:

    1. If the SDK gave us a `resets_at` (Unix timestamp) on the exception,
       sleep until that instant plus a small jitter and retry. This is the
       honest path for the five_hour / seven_day windows: we know exactly
       when the quota opens again, so there's no point guessing.
       `reset_wait_cap_seconds` is the ceiling on a single such wait: if
       the reported reset is further out than this, we give up on the
       reset-wait path and FALL THROUGH to exponential backoff (and then
       if that also exhausts, 429). Default 6h -> long enough to ride out
       a five_hour window fully, short enough that a seven_day window
       surfaces to ARTEX instead of hanging the request for a week.

    2. Otherwise exponential backoff: sleep min(base * 2**(N-1), cap)
       between attempt N and N+1, up to `attempts` total tries.

    `attempts` counts TOTAL attempts, not retries. `attempts=1` == first
    failure returns 429. After `attempts` tries (whichever path), we
    give up and 429 so ARTEX can decide; with unlimited budgets ARTEX
    retries on its own."""
    attempts: int = 1
    base_seconds: float = 5.0
    cap_seconds: float = 60.0
    reset_wait_cap_seconds: float = 6 * 60 * 60  # 6 hours
    reset_wait_jitter_seconds: float = 5.0

    def backoff_sleep_for(self, attempt_index: int) -> float:
        # attempt_index is the 1-indexed try that just failed.
        return min(self.base_seconds * (2 ** (attempt_index - 1)), self.cap_seconds)


def _anthropic_error(error_type: str, message: str, http_status: int) -> JSONResponse:
    return JSONResponse(
        status_code=http_status,
        content={"type": "error", "error": {"type": error_type, "message": message}},
    )


def _make_message_id() -> str:
    return f"msg_{secrets.token_hex(12)}"


def build_app(
    *,
    adapter: SdkAdapter,
    cache: PromptCache | None = None,
    limiter: RateLimiter | None = None,
    upstream_retry: UpstreamRetry | None = None,
) -> FastAPI:
    app = FastAPI(title="ARTEX ↔ Claude Agent SDK bridge", version="0.1.0")
    retry = upstream_retry or UpstreamRetry()

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return _anthropic_error("invalid_request_error", exc.errors()[0]["msg"], 400)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "artex-claude-bridge", "version": "0.1.0"}

    @app.post("/v1/messages")
    async def messages(request: Request) -> JSONResponse:
        try:
            payload = await request.json()
        except Exception:
            return _anthropic_error("invalid_request_error", "invalid JSON body", 400)

        try:
            req = MessagesRequest.model_validate(payload)
        except ValidationError as e:
            return _anthropic_error("invalid_request_error", e.errors()[0]["msg"], 400)

        system_str = normalize_system(req.system)
        msgs = normalize_messages(req.messages)
        tools = [t.model_dump() for t in req.tools] if req.tools else None

        # Cache includes tools so a request with the same prompt but different
        # tool set is treated as a different call.
        cache_messages = msgs + ([{"role": "__tools__", "content": repr(tools)}] if tools else [])
        if cache is not None:
            cached = await cache.get(
                system=system_str,
                messages=cache_messages,
                model=req.model,
                max_tokens=req.max_tokens,
            )
            if cached is not None:
                return (
                    _stream_response(cached)
                    if req.stream
                    else _success_response(cached)
                )

        async def _invoke_adapter() -> dict[str, Any]:
            return await adapter.complete(
                system=system_str,
                messages=msgs,
                model=req.model,
                max_tokens=req.max_tokens,
                tools=tools,
            )

        async def _invoke_with_retry() -> dict[str, Any]:
            last_exc: SubscriptionRateLimited | None = None
            for attempt in range(1, retry.attempts + 1):
                try:
                    if limiter is not None:
                        async with limiter.slot():
                            return await _invoke_adapter()
                    return await _invoke_adapter()
                except SubscriptionRateLimited as exc:
                    last_exc = exc
                    if attempt >= retry.attempts:
                        break
                    # Prefer the honest wait if the SDK told us when the
                    # window resets AND it's within the cap.
                    sleep_s: float | None = None
                    resets_at = getattr(exc, "resets_at", None)
                    rl_type = getattr(exc, "rate_limit_type", None)
                    if isinstance(resets_at, int):
                        now_s = time.time()
                        remaining = resets_at - now_s + retry.reset_wait_jitter_seconds
                        if 0 < remaining <= retry.reset_wait_cap_seconds:
                            sleep_s = remaining
                            log.warning(
                                "subscription rate limit on attempt %d/%d "
                                "(type=%s); window resets at %d (~%.0fs); "
                                "waiting that long",
                                attempt, retry.attempts, rl_type,
                                resets_at, remaining,
                            )
                    if sleep_s is None:
                        sleep_s = retry.backoff_sleep_for(attempt)
                        log.warning(
                            "subscription rate limit on attempt %d/%d "
                            "(type=%s, no usable resets_at); exp backoff %.1fs",
                            attempt, retry.attempts, rl_type, sleep_s,
                        )
                    await asyncio.sleep(sleep_s)
            assert last_exc is not None
            raise last_exc

        try:
            result = await _invoke_with_retry()
        except SubscriptionRateLimited as e:
            return _stream_error_response(e, "rate_limit_error") if req.stream else (
                _anthropic_error("rate_limit_error", str(e), 429)
            )

        if cache is not None:
            await cache.set(
                system=system_str,
                messages=cache_messages,
                model=req.model,
                max_tokens=req.max_tokens,
                value=result,
            )
        return _stream_response(result) if req.stream else _success_response(result)

    return app


def _stream_response(result: dict[str, Any]) -> StreamingResponse:
    return StreamingResponse(
        stream_result(result),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store"},
    )


def _stream_error_response(exc: Exception, error_type: str) -> StreamingResponse:
    return StreamingResponse(
        stream_error(error_type, str(exc)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store"},
    )


def _success_response(result: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "id": _make_message_id(),
            "type": "message",
            "role": "assistant",
            "model": result["model"],
            "content": result["content"],
            "stop_reason": result.get("stop_reason", "end_turn"),
            "stop_sequence": None,
            "usage": {
                "input_tokens": result["input_tokens"],
                "output_tokens": result["output_tokens"],
            },
        },
    )
