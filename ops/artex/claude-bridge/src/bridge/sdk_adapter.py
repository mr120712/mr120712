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
    ) -> dict[str, Any]:
        """Run one completion.

        Input `messages` are normalized to `[{role, content: str}, ...]`.
        Returns `{text, input_tokens, output_tokens, model}`.
        Raises `SubscriptionRateLimited` on the SDK's rate-limit signal.
        """
