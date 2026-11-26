# @polsia:user-owned — the seam between Anthropic Messages API shape and the
# Claude Agent SDK. The real adapter runs `claude_agent_sdk.query(...)`; tests
# subclass this ABC to stub out the SDK and assert on wire shape only.
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class SdkAdapter(ABC):
    @abstractmethod
    async def complete(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        model: str | None,
        max_tokens: int,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Run one completion.

        Input `messages` are normalized to `[{role, content: str}, ...]`.
        `tools` (when present) carries ARTEX's declared tool catalog
        verbatim: `[{name, description, input_schema}, ...]`.
        Returns `{content, stop_reason, input_tokens, output_tokens, model}`
        where `content` is an Anthropic content-block list (text and/or
        tool_use blocks) and `stop_reason` is one of `end_turn`, `tool_use`,
        `max_tokens`.
        Raises `SubscriptionRateLimited` on the SDK's rate-limit signal.
        """
