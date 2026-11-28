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

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKError,
    CLIConnectionError,
    CLIJSONDecodeError,
    CLINotFoundError,
    ProcessError,
    ResultError,
    SdkMcpTool,
    create_sdk_mcp_server,
    query,
)

from bridge.errors import SdkAuthRequired, SdkUnavailable, SubscriptionRateLimited
from bridge.sdk_adapter import SdkAdapter

MCP_SERVER_NAME = "artex"

# Substrings that mark a CLI failure as "the operator must re-authenticate"
# rather than a transient transport fault. Matched (lowercased) against the
# CLI's stderr/message. The remediation is always `claude login` in the bridge.
_AUTH_HINTS = (
    "not logged in",
    "please run `claude",
    "please run /login",
    "/login",
    "log in",
    "login",
    "authenticat",
    "unauthorized",
    "invalid api key",
    "no api key",
    "credit balance",
    "oauth",
    "token expired",
    "session expired",
)


def _classify_sdk_error(exc: Exception) -> Exception:
    """Map a Claude Agent SDK error onto a bridge error the route can turn into
    a clean Anthropic error envelope: an un-authenticated CLI (never ran
    `claude login`) becomes SdkAuthRequired with a remediation; every other
    transport/process fault becomes SdkUnavailable. Without this, these escape
    as a raw 500 that ARTEX's Anthropic client cannot parse — it just reports a
    failed POST with no cause."""
    detail = " ".join(
        part
        for part in (
            getattr(exc, "stderr", None),
            getattr(exc, "message", None),
            str(exc),
        )
        if part
    ).lower()
    if any(hint in detail for hint in _AUTH_HINTS):
        return SdkAuthRequired(
            "the Claude Code CLI in the bridge is not authenticated — run "
            "`docker compose exec claude-bridge claude login` once on the VPS "
            f"({exc.__class__.__name__})"
        )
    return SdkUnavailable(f"{exc.__class__.__name__}: {exc}")


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
    """Claude Agent SDK adapter with an optional cost-control model layer.

    ARTEX hard-codes one planner model via ARTEX_LLM_MODEL (default is the
    expensive `claude-opus-4-7`). Opus drains the Claude Code subscription
    window — and, in direct mode, pay-per-token budget — several times faster
    than Haiku/Sonnet for the same planning loop. Rather than force the operator
    to edit ARTEX's Go config, the bridge can rewrite the requested model
    centrally:

      * `model_override` — floor EVERY request to this model, whatever ARTEX
        asked for. The simplest "spend less" kill-switch.
      * `model_map` — selective remap, e.g. downgrade only opus
        ({"claude-opus-4-7": "claude-haiku-4-5"}) while leaving cheaper
        requests untouched. `model_override` wins when both are set.

    The cache key (in app.py) stays keyed on the *requested* model, so this is
    transparent to ARTEX and to retries.
    """

    def __init__(
        self,
        *,
        model_override: str | None = None,
        model_map: dict[str, str] | None = None,
    ) -> None:
        self._model_override = model_override or None
        self._model_map = model_map or {}

    def _resolve_model(self, requested: str | None) -> str | None:
        if self._model_override:
            return self._model_override
        if requested is not None and requested in self._model_map:
            return self._model_map[requested]
        return requested

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
        effective_model = self._resolve_model(model)

        mcp_servers: dict[str, Any] = {}
        allowed_tools: list[str] = []
        if tools:
            config, allowed = _build_mcp_from_artex_tools(tools)
            mcp_servers = {MCP_SERVER_NAME: config}
            allowed_tools = allowed

        options = ClaudeAgentOptions(
            system_prompt=system or None,
            model=effective_model,
            max_turns=1,
            permission_mode="bypassPermissions",
            # Disable ALL Claude Code CLI built-in tools (Bash, Read, Edit,
            # ToolSearch, ...). Without this the model would see them and may
            # call one instead of ARTEX's declared tools — a live integration
            # test caught that on the first run (model picked ToolSearch for
            # a URL probe). The only tools the model should know about are
            # the ARTEX ones we register as MCP tools.
            tools=[],
            mcp_servers=mcp_servers,
            allowed_tools=allowed_tools,
        )

        content_blocks: list[dict[str, Any]] = []
        usage: dict[str, Any] | None = None
        used_model = effective_model or "claude-haiku-4-5"
        saw_tool_use = False

        agen = None
        try:
            agen = query(prompt=prompt, options=options)
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
        except SubscriptionRateLimited:
            raise
        except CLINotFoundError as exc:
            raise SdkUnavailable(
                "the `claude` CLI is not installed in the bridge image"
            ) from exc
        except (
            ProcessError,
            CLIConnectionError,
            CLIJSONDecodeError,
            ResultError,
            ClaudeSDKError,
        ) as exc:
            raise _classify_sdk_error(exc) from exc
        except Exception as exc:  # noqa: BLE001 - never leak a raw failure to ARTEX
            raise SdkUnavailable(f"bridge SDK call failed: {exc}") from exc
        finally:
            if agen is not None:
                try:
                    await agen.aclose()
                except Exception:  # noqa: BLE001 - never mask the original error
                    pass

        # If the model emitted neither text nor tool_use (unlikely), surface an
        # empty text block so the response is still valid Anthropic shape.
        if not content_blocks:
            content_blocks = [{"type": "text", "text": ""}]

        emitted_text = "".join(
            b["text"] for b in content_blocks if b.get("type") == "text"
        )
        # Include tool_use serialized JSON in the output-size estimate so a
        # pure tool_use response (no text) still reports non-trivial tokens.
        import json as _json

        emitted_payload = emitted_text + "".join(
            _json.dumps(b.get("input") or {}) for b in content_blocks if b.get("type") == "tool_use"
        )
        input_estimate = _estimate_tokens(prompt + (system or ""))
        output_estimate = _estimate_tokens(emitted_payload)
        # Live-test finding: the Claude Code SDK's ResultMessage.usage reports a
        # per-turn delta, not the Anthropic-API-equivalent cumulative count.
        # ARTEX uses these for ARTEX_TASK_BUDGET_TOKENS enforcement, so we
        # floor both at our own chars/4 estimate — the budget then stops
        # runaway tasks even when the SDK undercounts by 20-50x.
        sdk_input = int((usage or {}).get("input_tokens") or 0)
        sdk_output = int((usage or {}).get("output_tokens") or 0)
        input_tokens = max(input_estimate, sdk_input)
        output_tokens = max(output_estimate, sdk_output)

        return {
            "content": content_blocks,
            "stop_reason": "tool_use" if saw_tool_use else "end_turn",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "model": used_model,
        }
