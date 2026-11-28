# @polsia:user-owned — FastAPI app factory. Keep the route thin; all business
# logic (SDK call, cache, rate limit) lives behind injected collaborators so
# tests can run the HTTP surface against fakes.
from __future__ import annotations

import logging
import secrets
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from bridge.cache import PromptCache
from bridge.errors import SdkAuthRequired, SdkUnavailable, SubscriptionRateLimited
from bridge.rate_limit import RateLimited, RateLimiter
from bridge.schema import MessagesRequest, normalize_messages, normalize_system
from bridge.sdk_adapter import SdkAdapter
from bridge.sse import stream_error, stream_result

log = logging.getLogger("artex-claude-bridge")


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
) -> FastAPI:
    app = FastAPI(title="ARTEX ↔ Claude Agent SDK bridge", version="0.1.0")

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

        try:
            if limiter is not None:
                async with limiter.slot():
                    result = await _invoke_adapter()
            else:
                result = await _invoke_adapter()
        except RateLimited as e:
            return _stream_error_response(e, "rate_limit_error") if req.stream else (
                _anthropic_error("rate_limit_error", str(e), 429)
            )
        except SubscriptionRateLimited as e:
            return _stream_error_response(e, "rate_limit_error") if req.stream else (
                _anthropic_error("rate_limit_error", str(e), 429)
            )
        except SdkAuthRequired as e:
            # The bridge CLI is not logged in. Tell ARTEX (and the operator)
            # exactly how to fix it instead of a blank failed POST.
            log.error("bridge not authenticated: %s", e)
            return _stream_error_response(e, "authentication_error") if req.stream else (
                _anthropic_error("authentication_error", str(e), 401)
            )
        except SdkUnavailable as e:
            log.error("bridge SDK unavailable: %s", e)
            return _stream_error_response(e, "api_error") if req.stream else (
                _anthropic_error("api_error", str(e), 502)
            )
        except Exception as e:  # noqa: BLE001 - never surface a raw 500 to ARTEX
            log.exception("bridge adapter failed on /v1/messages")
            return _stream_error_response(e, "api_error") if req.stream else (
                _anthropic_error("api_error", f"bridge adapter failure: {e}", 500)
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
