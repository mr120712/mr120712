# @polsia:user-owned — the real Claude Agent SDK adapter. Runs the SDK's
# `query` function with `permission_mode='bypassPermissions'` and NO tools, so
# the model emits a single assistant-text turn and then stops. We flatten
# the Messages API conversation into a single prompt with role markers; the
# system prompt goes through `options.system_prompt`.
#
# Rate limit detection: the SDK may surface the subscription window being
# exhausted as a `RateLimitEvent` with status=="rejected", OR as a terminal
# `ResultMessage` with `terminal_reason == "rate_limit"` or
# `api_error_status == 429`. Either shape raises `SubscriptionRateLimited`.
from __future__ import annotations

from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, query

from bridge.errors import SubscriptionRateLimited
from bridge.sdk_adapter import SdkAdapter


def _estimate_tokens(text: str) -> int:
    # Rough heuristic when the SDK gives us no usage; 1 token ≈ 4 chars.
    return max(1, len(text) // 4)


def _flatten_prompt(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for m in messages:
        role = m["role"].upper()
        parts.append(f"{role}:\n{m['content']}")
    return "\n\n".join(parts)


class ClaudeSdkAdapter(SdkAdapter):
    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
    ) -> dict[str, Any]:
        prompt = _flatten_prompt(messages)
        options = ClaudeAgentOptions(
            system_prompt=system or None,
            model=model,
            max_turns=1,
            permission_mode="bypassPermissions",
            allowed_tools=[],
            disallowed_tools=[],
        )

        assistant_text_parts: list[str] = []
        usage: dict[str, Any] | None = None
        used_model = model or "claude-opus-4-7"

        async for msg in query(prompt=prompt, options=options):
            # Duck-typed so tests can substitute plain dataclasses, and the SDK
            # can evolve its concrete classes without breaking this module.
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
                for block in msg.content:
                    text_val = getattr(block, "text", None)
                    if isinstance(text_val, str):
                        assistant_text_parts.append(text_val)
                if getattr(msg, "error", None) == "rate_limit":
                    raise SubscriptionRateLimited(
                        "Claude Code subscription rate limit reported on AssistantMessage"
                    )
                if msg_usage:
                    usage = msg_usage
                continue

        text = "".join(assistant_text_parts)
        if usage is None:
            input_tokens = _estimate_tokens(prompt + (system or ""))
            output_tokens = _estimate_tokens(text)
        else:
            input_tokens = int(usage.get("input_tokens") or _estimate_tokens(prompt))
            output_tokens = int(usage.get("output_tokens") or _estimate_tokens(text))

        return {
            "text": text,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "model": used_model,
        }
