---
title: DeepSeek Chat (static, private)
emoji: 🐋
colorFrom: indigo
colorTo: gray
sdk: static
app_file: index.html
pinned: false
short_description: Browser-only chat for an OpenAI-compatible server
---

# DeepSeek chat — static, browser-only

A static chat page for an OpenAI-compatible server (vLLM, SGLang, llama.cpp server, …) running
[OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated](https://huggingface.co/OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated)
or any other model. Static Spaces run no code on Hugging Face: the page talks to your server
**directly from your browser**.

**Keep this Space private.** The model's own card reports high rates of harmful assistance.

## Use

1. Open the Space and press **⚙️ Server**.
2. Enter the server's base URL (e.g. `https://my-gpu-box.example.com/v1`), the API key if it needs
   one, and the model name.
3. These are stored only in **your browser** (localStorage), never in the Space files.

## Ready-made backend: Solco (MWAPI)

Without a GPU server of your own, use Solco's endpoint. With `HF_INFERENCE_TOKEN` on Vercel it serves
`OBLITERATUS/Qwen3.8-27B-OBLITERATED` (Featherless via Hugging Face, billed to Solcomusic); otherwise
MWAPI, the same models as `/ds`:

| Field | Value |
|---|---|
| URL base | `https://solcomusic.online/api/space-chat/v1` |
| Chiave API | the value of `SPACE_CHAT_API_KEY` on Vercel |
| Modello | `OBLITERATUS/Qwen3.8-27B-OBLITERATED` (with `HF_INFERENCE_TOKEN` on Vercel) or `solco-mwapi` |

Only this Space's address may call it (CORS), and the key is required.

## Own server requirements

- HTTPS, and CORS that allows this Space's origin, e.g. with vLLM:
  `vllm serve <model> --api-key "$KEY" --allowed-origins '["https://solcomusic-deepseek-static-chat.static.hf.space"]'`
- The `/v1/chat/completions` endpoint with streaming.
