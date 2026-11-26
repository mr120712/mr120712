# @polsia:user-owned — error types for the bridge.
from __future__ import annotations


class SubscriptionRateLimited(Exception):
    """Raised by the SDK adapter when the Claude Code subscription window is
    exhausted. The route handler maps it to Anthropic's `rate_limit_error`."""


class SdkAuthRequired(Exception):
    """Raised when the Claude CLI has not been logged in yet. The route handler
    maps it to Anthropic's `authentication_error` with a clear remediation."""


class SdkUnavailable(Exception):
    """Any other SDK transport error (CLI not found, process crashed, timeout)."""
