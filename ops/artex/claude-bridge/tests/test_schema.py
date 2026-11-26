# @polsia:user-owned — RED tests for the schema normalizers. These describe
# how `normalize_messages` flattens tool_use + tool_result blocks so the SDK
# (which only accepts text-shaped prompts) can see the full agent loop.
from __future__ import annotations

from bridge.schema import Message, normalize_messages, normalize_system


def test_normalize_system_string_pass_through() -> None:
    assert normalize_system("just a string") == "just a string"


def test_normalize_system_none() -> None:
    assert normalize_system(None) == ""


def test_normalize_system_block_array_joins_with_blank_lines() -> None:
    out = normalize_system(
        [
            {"type": "text", "text": "alpha"},
            {"type": "text", "text": "beta"},
        ]
    )
    assert out == "alpha\n\nbeta"


def test_normalize_messages_string_content() -> None:
    out = normalize_messages([Message(role="user", content="hello")])
    assert out == [{"role": "user", "content": "hello"}]


def test_normalize_messages_text_block_array() -> None:
    out = normalize_messages(
        [Message(role="user", content=[{"type": "text", "text": "hi"}])]
    )
    assert out == [{"role": "user", "content": "hi"}]


def test_normalize_messages_tool_use_block_preserves_id_name_input() -> None:
    out = normalize_messages(
        [
            Message(
                role="assistant",
                content=[
                    {"type": "text", "text": "Calling it."},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "http_get",
                        "input": {"url": "https://x.test"},
                    },
                ],
            )
        ]
    )
    assert out[0]["role"] == "assistant"
    flat = out[0]["content"]
    assert "Calling it." in flat
    assert "toolu_1" in flat
    assert "http_get" in flat
    # Input is JSON-formatted so the model can parse it if it wants to reason
    # about the exact arguments.
    assert '"url"' in flat
    assert "https://x.test" in flat


def test_normalize_messages_tool_result_with_string_content() -> None:
    out = normalize_messages(
        [
            Message(
                role="user",
                content=[
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "HTTP 200\nserver: nginx",
                    }
                ],
            )
        ]
    )
    flat = out[0]["content"]
    assert "toolu_1" in flat
    assert "HTTP 200" in flat
    assert "server: nginx" in flat


def test_normalize_messages_tool_result_with_block_array_content() -> None:
    # Anthropic spec: tool_result.content can be an array of {type:text, text}.
    out = normalize_messages(
        [
            Message(
                role="user",
                content=[
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": [
                            {"type": "text", "text": "line one"},
                            {"type": "text", "text": "line two"},
                        ],
                    }
                ],
            )
        ]
    )
    flat = out[0]["content"]
    assert "line one" in flat
    assert "line two" in flat


def test_normalize_messages_tool_result_is_error_marked() -> None:
    out = normalize_messages(
        [
            Message(
                role="user",
                content=[
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "DNS failure",
                        "is_error": True,
                    }
                ],
            )
        ]
    )
    flat = out[0]["content"]
    assert "(error)" in flat
    assert "DNS failure" in flat


def test_normalize_messages_full_agent_loop_round_trip() -> None:
    # Full three-turn loop: user asks, assistant calls tool, user replies with
    # result. The adapter must see all three with roles preserved.
    out = normalize_messages(
        [
            Message(role="user", content="probe example.test"),
            Message(
                role="assistant",
                content=[
                    {"type": "text", "text": "I'll probe it."},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "http_get",
                        "input": {"url": "https://example.test"},
                    },
                ],
            ),
            Message(
                role="user",
                content=[
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "HTTP 200",
                    }
                ],
            ),
        ]
    )
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    assert "probe example.test" in out[0]["content"]
    assert "toolu_1" in out[1]["content"]
    assert "HTTP 200" in out[2]["content"]
