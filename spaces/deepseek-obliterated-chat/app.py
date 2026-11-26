"""Private chat front-end for a self-hosted DeepSeek-V4.1-Flash-1017-obliterated server.

The Space does no inference itself. It streams chat completions from an
OpenAI-compatible server you run (vLLM, SGLang, TGI, llama.cpp server, ...).

Space secrets (Settings -> Variables and secrets):
  ENDPOINT_URL    base URL of the server, e.g. https://my-gpu-box.example.com/v1  (required)
  ENDPOINT_TOKEN  bearer token for the server, if it requires one                  (optional)
  MODEL_ID        model name the server registered                                 (optional)
"""

import os

import gradio as gr
from openai import OpenAI

try:  # Only present on ZeroGPU hardware; a free account needs one decorated function.
    import spaces

    @spaces.GPU(duration=1)
    def _noop():  # never called; no GPU quota is used
        pass

except ImportError:
    pass

ENDPOINT_URL = os.environ.get("ENDPOINT_URL", "").strip()
ENDPOINT_TOKEN = os.environ.get("ENDPOINT_TOKEN", "").strip() or "not-needed"
MODEL_ID = os.environ.get("MODEL_ID", "OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated").strip()

client = OpenAI(base_url=ENDPOINT_URL, api_key=ENDPOINT_TOKEN, timeout=600) if ENDPOINT_URL else None


def _text(content) -> str:
    """Flatten Gradio message content (str, or a list of typed parts) into plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or "")
    if isinstance(content, (list, tuple)):
        return "".join(_text(part) for part in content)
    return "" if content is None else str(content)


def chat(message, history, system_prompt: str, temperature: float, top_p: float, max_tokens: int):
    """Stream a reply from the self-hosted model."""
    if client is None:
        yield "⚠️ `ENDPOINT_URL` is not set. Add it under the Space's Settings → Variables and secrets."
        return

    messages = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    for turn in history:
        if turn.get("role") in ("user", "assistant"):
            text = _text(turn.get("content"))
            if text:
                messages.append({"role": turn["role"], "content": text})
    messages.append({"role": "user", "content": _text(message)})

    try:
        stream = client.chat.completions.create(
            model=MODEL_ID,
            messages=messages,
            temperature=temperature,
            top_p=top_p,
            max_tokens=int(max_tokens),
            stream=True,
        )
        reply = ""
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                reply += chunk.choices[0].delta.content
                yield reply
        if not reply:
            yield "_(empty response)_"
    except Exception as exc:  # surface server/network errors in the chat
        yield f"⚠️ Endpoint error: `{type(exc).__name__}: {exc}`"


with gr.Blocks(title="DeepSeek-V4.1-Flash obliterated — private", fill_height=True) as demo:
    gr.Markdown(
        "## DeepSeek-V4.1-Flash-1017-obliterated\n"
        f"Private chat with your self-hosted server · model `{MODEL_ID}` · "
        f"endpoint {'connected' if client else '**not configured**'}"
    )
    gr.ChatInterface(
        fn=chat,
        additional_inputs=[
            gr.Textbox(label="System prompt", value="You are a helpful assistant.", lines=2),
            gr.Slider(0.0, 2.0, value=0.6, step=0.05, label="Temperature"),
            gr.Slider(0.05, 1.0, value=0.95, step=0.05, label="Top-p"),
            gr.Slider(64, 8192, value=2048, step=64, label="Max new tokens"),
        ],
        additional_inputs_accordion=gr.Accordion("Generation settings", open=False),
        examples=[
            ["Explain how mixture-of-experts routing works, in three paragraphs."],
            ["Write a Python function that merges overlapping intervals."],
        ],
        cache_examples=False,
        fill_height=True,
    )

if __name__ == "__main__":
    demo.queue(default_concurrency_limit=4).launch()
