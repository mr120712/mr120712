# @polsia:user-owned — error types for the bridge.
from __future__ import annotations


class SubscriptionRateLimited(Exception):
    """Raised by the SDK adapter when the Claude Code subscription window is
    exhausted. Carries, when the SDK provided one, the Unix timestamp at
    which the limiting window resets (`resets_at`) and the rate-limit type
    (`five_hour`, `seven_day`, ...). The route handler uses those to wait
    until the real reset instead of guessing with exp backoff."""

    def __init__(
        self,
        message: str,
        *,
        resets_at: int | None = None,
        rate_limit_type: str | None = None,
    ) -> None:
        super().__init__(message)
        self.resets_at = resets_at
        self.rate_limit_type = rate_limit_type


class SdkAuthRequired(Exception):
    """Raised when the Claude CLI has not been logged in yet. The route handler
    maps it to Anthropic's `authentication_error` with a clear remediation."""


class SdkUnavailable(Exception):
    """Any other SDK transport error (CLI not found, process crashed, timeout)."""
