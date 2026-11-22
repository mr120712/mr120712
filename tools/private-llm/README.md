# Private uncensored model for `/deepseek` (owner-only)

Build a refusal-ablated copy of an open model with OBLITERATUS on a GPU you rent, serve it with vLLM
behind an API key, and point the existing owner-only chat (`/admin/deepseek` + Telegram `/deepseek`)
at it through the yt-dlp worker. **No bot code changes**: the chain is
Solco/bot → worker `POST /chat` → your vLLM server.

Keep it private. The model will answer requests the original refused; it is reachable only through
the worker (Bearer `WORKER_API_KEY`), which only Solco's admin route and the bot's owner gate call.
Never expose the vLLM port without `--api-key`.

## 0. Pick the size

| Model (default first) | GPU (RunPod) | Disk |
|---|---|---|
| `meta-llama/Llama-3.1-8B-Instruct` (gated: accept the licence on HF first) | 1× L40S / A6000 48 GB | 60 GB |
| `Qwen/Qwen2.5-32B-Instruct` | 1× A100 / H100 80 GB | 150 GB |

## 1. Rent the GPU

RunPod → **Pods → Deploy**: the GPU above, template **RunPod PyTorch** (CUDA 12), container disk as
above, **expose HTTP port 8000**. Open the pod's web terminal.

## 2. Build the model (once, ~10–40 min)

```bash
export HF_TOKEN=hf_...            # read token; needed for gated models (Llama)
curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/new-session-e8afhd/tools/private-llm/build.sh -o build.sh
MODEL=meta-llama/Llama-3.1-8B-Instruct bash build.sh
```

Output: `/workspace/liberated/` (weights + tokenizer). Re-running skips if it already exists.

## 3. Serve it

```bash
export VLLM_API_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
echo "$VLLM_API_KEY"   # copy it now: it goes in Render as DEEPSEEK_ENDPOINT_TOKEN
curl -fsSL https://raw.githubusercontent.com/mr120712/mr120712/claude/new-session-e8afhd/tools/private-llm/serve.sh -o serve.sh
nohup bash serve.sh > vllm.log 2>&1 &
tail -f vllm.log       # wait for "Application startup complete"
```

Public URL: `https://<POD_ID>-8000.proxy.runpod.net/v1` (POD_ID is in the RunPod dashboard).
Check: `curl -H "Authorization: Bearer $VLLM_API_KEY" https://<POD_ID>-8000.proxy.runpod.net/v1/models`
→ lists `solco-private`; without the header → 401.

## 4. Wire it in

**Render → `s2a76b51c9520ac-tbbb` (yt-dlp worker) → Environment**

| Key | Value |
|---|---|
| `DEEPSEEK_ENDPOINT_URL` | `https://<POD_ID>-8000.proxy.runpod.net/v1` |
| `DEEPSEEK_ENDPOINT_TOKEN` | the `VLLM_API_KEY` from step 3 (replaces the HF token) |
| `DEEPSEEK_MODEL_ID` | `solco-private` |

**Vercel → Solco → Environment Variables**: `DEEPSEEK_BACKEND=worker`, and `YTDLP_SERVICE_KEY2`
(or `YTDLP_SERVICE_KEY`) = the worker key. Redeploy.

Test: `/ds ciao` in your private chat with the bot, or `/admin/deepseek`.

## Costs and stopping

The pod bills per hour while it runs (~$0.8/h for 48 GB, ~$2–3/h for 80 GB). **Stop** the pod when
you're not using it — the bot then answers "il server DeepSeek non risponde". Keep the volume to
avoid rebuilding; after a restart run step 3 again (the RunPod URL stays the same for the same pod).
To go back to Solco's AI reserve, set `DEEPSEEK_BACKEND=solco` (or remove it) on Vercel.

OBLITERATUS is AGPL-3.0; `build.sh` pins it to commit `18f3a10` of the
`pliny-the-prompter/obliteratus` Space.
