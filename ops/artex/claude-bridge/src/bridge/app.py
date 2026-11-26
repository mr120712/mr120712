# @polsia:user-owned — FastAPI app factory. Keep the route thin; all business
# logic (SDK call, cache, rate limit) lives behind injected collaborators so
# tests can run the HTTP surface against fakes.
from __future__ import annotations

import secrets
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from bridge.cache import PromptCache
from bridge.errors import SubscriptionRateLimited
from bridge.rate_limit import RateLimited, RateLimiter
from bridge.schema import MessagesRequest, normalize_messages, normalize_system
from bridge.sdk_adapter import SdkAdapter


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

        if req.stream:
            return _anthropic_error(
                "not_implemented",
                "streaming (SSE) is not yet supported by this bridge; set ARTEX_LLM_STREAM=false",
                501,
            )

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
                return _success_response(cached)

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
            return _anthropic_error("rate_limit_error", str(e), 429)
        except SubscriptionRateLimited as e:
            return _anthropic_error("rate_limit_error", str(e), 429)

        if cache is not None:
            await cache.set(
                system=system_str,
                messages=cache_messages,
                model=req.model,
                max_tokens=req.max_tokens,
                value=result,
            )
        return _success_response(result)

    return app


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
