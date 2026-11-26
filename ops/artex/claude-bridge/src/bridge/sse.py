# @polsia:user-owned — SSE formatter. Takes a fully-collected adapter result
# (text and/or tool_use content blocks + stop_reason + usage) and yields the
# Anthropic Messages API SSE event sequence:
#   message_start
#     (content_block_start → content_block_delta* → content_block_stop)+
#   message_delta
#   message_stop
#
# Faked streaming: the response is already complete when we start emitting,
# so there's no latency gain vs. the non-streaming path. The point is wire
# protocol compatibility with ARTEX's Go client, whose default path parses
# SSE and reads `usage.input_tokens` from message_start / final
# `usage.output_tokens` from message_delta.
from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from typing import Any

# Chunk sizes are generous: SSE framing overhead stays small and we're not
# optimizing latency here, only protocol.
TEXT_CHUNK = 160
JSON_CHUNK = 160


def _frame(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def _make_message_id() -> str:
    return f"msg_{secrets.token_hex(12)}"


def _chunks(s: str, size: int) -> list[str]:
    if not s:
        return [""]
    return [s[i : i + size] for i in range(0, len(s), size)]


async def stream_result(result: dict[str, Any]) -> AsyncIterator[bytes]:
    message_id = _make_message_id()
    model = result.get("model") or "claude-opus-4-7"
    stop_reason = result.get("stop_reason") or "end_turn"
    input_tokens = int(result.get("input_tokens") or 0)
    output_tokens = int(result.get("output_tokens") or 0)
    content: list[dict[str, Any]] = result.get("content") or []

    yield _frame(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": input_tokens, "output_tokens": 0},
            },
        },
    )

    for idx, block in enumerate(content):
        t = block.get("type")
        if t == "text":
            yield _frame(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": idx,
                    "content_block": {"type": "text", "text": ""},
                },
            )
            for chunk in _chunks(block.get("text", ""), TEXT_CHUNK):
                yield _frame(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": idx,
                        "delta": {"type": "text_delta", "text": chunk},
                    },
                )
            yield _frame(
                "content_block_stop", {"type": "content_block_stop", "index": idx}
            )
        elif t == "tool_use":
            yield _frame(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": idx,
                    "content_block": {
                        "type": "tool_use",
                        "id": block.get("id"),
                        "name": block.get("name"),
                        "input": {},
                    },
                },
            )
            input_json = json.dumps(block.get("input") or {}, ensure_ascii=False)
            for chunk in _chunks(input_json, JSON_CHUNK):
                yield _frame(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": idx,
                        "delta": {"type": "input_json_delta", "partial_json": chunk},
                    },
                )
            yield _frame(
                "content_block_stop", {"type": "content_block_stop", "index": idx}
            )

    yield _frame(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": output_tokens},
        },
    )
    yield _frame("message_stop", {"type": "message_stop"})


async def stream_error(error_type: str, message: str) -> AsyncIterator[bytes]:
    """Anthropic surfaces a mid-stream error as `event: error` with a 200 body."""
    yield _frame(
        "error",
        {"type": "error", "error": {"type": error_type, "message": message}},
    )
