# @polsia:user-owned — the real Claude Agent SDK adapter.
#
# TEXT-ONLY PATH: flatten the conversation into a single prompt, call the SDK
# with `permission_mode='bypassPermissions'`, max_turns=1, no tools. Return the
# first AssistantMessage's text joined.
#
# TOOL_USE PATH: register ARTEX's declared tools as in-process SDK MCP tools
# (one SdkMcpTool per declared tool; input_schema is JSON Schema which the SDK
# accepts as a dict directly), set `mcp_servers={"artex": config}` and
# `allowed_tools=["mcp__artex__<name>", ...]`, then run `query` with
# max_turns=1. When the AssistantMessage comes back with a ToolUseBlock, we
# capture its name/input/id, strip the `mcp__artex__` prefix so ARTEX sees its
# own tool name back, and return a tool_use content block alongside any
# emitted text. The MCP tool handlers are no-ops because max_turns=1 stops
# the SDK before another LLM turn — but we still define them because
# create_sdk_mcp_server needs them.
#
# Rate limit: `RateLimitEvent{status:rejected}` or `ResultMessage` with
# terminal_reason=rate_limit / api_error_status=429 → `SubscriptionRateLimited`.
from __future__ import annotations

from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, SdkMcpTool, create_sdk_mcp_server, query

from bridge.errors import SubscriptionRateLimited
from bridge.sdk_adapter import SdkAdapter

MCP_SERVER_NAME = "artex"


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _flatten_prompt(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for m in messages:
        role = m["role"].upper()
        parts.append(f"{role}:\n{m['content']}")
    return "\n\n".join(parts)


async def _noop_handler(_args: dict[str, Any]) -> dict[str, Any]:
    # Never actually called in the tool_use capture path because we break out
    # of the stream as soon as the ToolUseBlock lands and before the SDK runs
    # another turn. Defined for completeness so create_sdk_mcp_server accepts
    # the tool.
    return {"content": [{"type": "text", "text": "captured"}]}


def _build_mcp_from_artex_tools(tools: list[dict[str, Any]]):
    sdk_tools = [
        SdkMcpTool(
            name=t["name"],
            description=t.get("description") or "",
            input_schema=t.get("input_schema") or {"type": "object"},
            handler=_noop_handler,
            annotations=None,
        )
        for t in tools
    ]
    config = create_sdk_mcp_server(name=MCP_SERVER_NAME, tools=sdk_tools)
    allowed = [f"mcp__{MCP_SERVER_NAME}__{t['name']}" for t in tools]
    return config, allowed


def _strip_mcp_prefix(name: str) -> str:
    prefix = f"mcp__{MCP_SERVER_NAME}__"
    return name[len(prefix):] if name.startswith(prefix) else name


class ClaudeSdkAdapter(SdkAdapter):
    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        prompt = _flatten_prompt(messages)

        mcp_servers: dict[str, Any] = {}
        allowed_tools: list[str] = []
        if tools:
            config, allowed = _build_mcp_from_artex_tools(tools)
            mcp_servers = {MCP_SERVER_NAME: config}
            allowed_tools = allowed

        options = ClaudeAgentOptions(
            system_prompt=system or None,
            model=model,
            max_turns=1,
            permission_mode="bypassPermissions",
            mcp_servers=mcp_servers,
            allowed_tools=allowed_tools,
        )

        content_blocks: list[dict[str, Any]] = []
        usage: dict[str, Any] | None = None
        used_model = model or "claude-opus-4-7"
        saw_tool_use = False

        agen = query(prompt=prompt, options=options)
        try:
            async for msg in agen:
                # Duck-typed so tests can substitute plain dataclasses, and the
                # SDK can evolve its concrete classes without breaking this.
                info = getattr(msg, "rate_limit_info", None)
                if info is not None:
                    if getattr(info, "status", None) == "rejected":
                        raise SubscriptionRateLimited(
                            f"Claude Code subscription rate limit rejected "
                            f"(type={getattr(info, 'rate_limit_type', None)})"
                        )
                    continue

                terminal_reason = getattr(msg, "terminal_reason", None)
                api_error_status = getattr(msg, "api_error_status", None)
                msg_usage = getattr(msg, "usage", None)
                is_assistant = isinstance(getattr(msg, "content", None), list)
                is_result = hasattr(msg, "num_turns") and hasattr(msg, "duration_ms")

                if is_result:
                    if terminal_reason == "rate_limit" or api_error_status == 429:
                        raise SubscriptionRateLimited(
                            "Claude Code subscription rate limit on terminal ResultMessage"
                        )
                    if msg_usage:
                        usage = msg_usage
                    break

                if is_assistant:
                    mdl = getattr(msg, "model", None)
                    if mdl:
                        used_model = mdl
                    text_buffer: list[str] = []
                    for block in msg.content:
                        text_val = getattr(block, "text", None)
                        tu_id = getattr(block, "id", None)
                        tu_name = getattr(block, "name", None)
                        tu_input = getattr(block, "input", None)
                        if isinstance(text_val, str):
                            text_buffer.append(text_val)
                        elif tu_id and tu_name and isinstance(tu_input, dict):
                            # Flush any buffered text first so order is kept.
                            if text_buffer:
                                content_blocks.append(
                                    {"type": "text", "text": "".join(text_buffer)}
                                )
                                text_buffer = []
                            content_blocks.append(
                                {
                                    "type": "tool_use",
                                    "id": tu_id,
                                    "name": _strip_mcp_prefix(tu_name),
                                    "input": tu_input,
                                }
                            )
                            saw_tool_use = True
                    if text_buffer:
                        content_blocks.append({"type": "text", "text": "".join(text_buffer)})
                    if getattr(msg, "error", None) == "rate_limit":
                        raise SubscriptionRateLimited(
                            "Claude Code subscription rate limit reported on AssistantMessage"
                        )
                    if msg_usage:
                        usage = msg_usage
                    if saw_tool_use:
                        # Stop reading the stream as soon as a tool_use lands.
                        # The MCP handler would otherwise execute (returning the
                        # captured no-op result), and the SDK may emit an extra
                        # UserMessage with a ToolResultBlock we don't need.
                        break
                    continue
        finally:
            await agen.aclose()

        # If the model emitted neither text nor tool_use (unlikely), surface an
        # empty text block so the response is still valid Anthropic shape.
        if not content_blocks:
            content_blocks = [{"type": "text", "text": ""}]

        emitted_text = "".join(
            b["text"] for b in content_blocks if b.get("type") == "text"
        )
        if usage is None:
            input_tokens = _estimate_tokens(prompt + (system or ""))
            output_tokens = _estimate_tokens(emitted_text)
        else:
            input_tokens = int(usage.get("input_tokens") or _estimate_tokens(prompt))
            output_tokens = int(usage.get("output_tokens") or _estimate_tokens(emitted_text))

        return {
            "content": content_blocks,
            "stop_reason": "tool_use" if saw_tool_use else "end_turn",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "model": used_model,
        }
