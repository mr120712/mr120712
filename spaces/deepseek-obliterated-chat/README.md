---
title: DeepSeek V4.1 Flash Obliterated (private)
emoji: 🐋
colorFrom: indigo
colorTo: gray
sdk: gradio
sdk_version: 6.32.0
app_file: app.py
python_version: "3.12"
short_description: Private chat UI for a self-hosted DeepSeek server
---

# DeepSeek-V4.1-Flash-1017-obliterated — private chat

A thin Gradio chat front-end for
[OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated](https://huggingface.co/OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated).
The model is about 755B parameters (about 1.5 TB in BF16), more than any Space hardware can hold, and no
inference provider serves it. So this Space runs **no inference itself**: it streams from an
OpenAI-compatible server that you host (vLLM, SGLang, etc.).

**Keep this Space private.** Its own model card reports high rates of harmful assistance.

## Configure

Under **Settings → Variables and secrets**, add these as *secrets*:

| Secret | Required | Example |
|---|---|---|
| `ENDPOINT_URL` | yes | `https://my-gpu-box.example.com/v1` |
| `ENDPOINT_TOKEN` | if your server needs auth | `sk-...` |
| `MODEL_ID` | if the server registered a different name | `OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated` |

Example server (multi-node, about 16×H200-class GPUs for BF16):

```bash
vllm serve OBLITERATUS/DeepSeek-V4.1-Flash-1017-obliterated \
  --tensor-parallel-size 8 --pipeline-parallel-size 2 \
  --api-key "$ENDPOINT_TOKEN"
```
