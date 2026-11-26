# @polsia:user-owned — Pydantic models for the subset of Anthropic Messages API
# that ARTEX's Go client actually sends (per the fork research on BaaRai/ARTEX
# v0.7.0 + Autumn-27/norma). Non-standard extensions `thinking` and
# `output_config` are accepted and ignored.
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class TextBlock(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["text"]
    text: str


class ToolUseBlock(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["tool_use"]
    id: str
    name: str
    input: dict[str, Any] = Field(default_factory=dict)


class ToolResultBlock(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["tool_result"]
    tool_use_id: str
    content: Any
    is_error: bool = False


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: Literal["user", "assistant"]
    content: str | list[dict[str, Any]]


class ToolDef(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str
    description: str | None = None
    input_schema: dict[str, Any] = Field(default_factory=dict)


class MessagesRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str
    max_tokens: int = Field(gt=0)
    messages: list[Message] = Field(min_length=1)
    system: str | list[dict[str, Any]] | None = None
    tools: list[ToolDef] | None = None
    tool_choice: dict[str, Any] | str | None = None
    stream: bool = False
    temperature: float | None = None
    stop_sequences: list[str] | None = None
    thinking: dict[str, Any] | None = None  # ARTEX extension — accepted, unused
    output_config: dict[str, Any] | None = None  # ARTEX extension — accepted, unused


def normalize_system(system: str | list[dict[str, Any]] | None) -> str:
    """Flatten ARTEX's `[{type:text, text}, ...]` system array into a single
    joined string the Agent SDK can consume as `system_prompt`."""
    if system is None:
        return ""
    if isinstance(system, str):
        return system
    parts: list[str] = []
    for block in system:
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n\n".join(parts)


def normalize_messages(messages: list[Message]) -> list[dict[str, Any]]:
    """Flatten per-message content blocks into a single text string per message.
    Accepts a string, a list of text blocks, or a list of mixed blocks.
    tool_result and tool_use blocks are stringified for the text-only v1."""
    out: list[dict[str, Any]] = []
    for m in messages:
        if isinstance(m.content, str):
            out.append({"role": m.role, "content": m.content})
            continue
        parts: list[str] = []
        for block in m.content:
            t = block.get("type")
            if t == "text":
                parts.append(block.get("text", ""))
            elif t == "tool_use":
                parts.append(f"[tool_use name={block.get('name')} input={block.get('input')}]")
            elif t == "tool_result":
                parts.append(f"[tool_result id={block.get('tool_use_id')} content={block.get('content')}]")
        out.append({"role": m.role, "content": "\n".join(parts)})
    return out
