# ARTEX ↔ Claude Agent SDK bridge

A local HTTP sidecar that speaks the **Anthropic Messages API** on the outside
and drives the **Claude Code subscription** on the inside. ARTEX (the Go
pentesting agent in `ops/artex/`) talks to this bridge as if it were
`api.anthropic.com`; the bridge in turn runs each prompt through the Claude
Agent SDK, which uses the `claude` CLI binary and your logged-in Claude Code
account.

**Net effect**: ARTEX's planner runs on your Claude Code subscription instead of
burning pay-per-token Anthropic/OpenAI credits.

## What it does

- Serves `POST /v1/messages` and returns responses in Anthropic's exact wire
  shape (id, type, role, content[], stop_reason, usage).
- Accepts the quirks ARTEX's Go client (BaaRai/ARTEX + Autumn-27/norma) sends:
  `system` as either a string or a `[{type:text,text}]` array,
  message `content` as either a string or a block array, and the non-standard
  `thinking` / `output_config` extensions.
- Caches identical prompts in SQLite so a retry is free.
- Rate-limits locally (RPS + in-flight) to protect the subscription window.
- Surfaces subscription rate-limit rejections as HTTP 429 `rate_limit_error`,
  which ARTEX treats as a transient fault.

## What it does NOT do (yet)

- **No tool_use passthrough.** If ARTEX sends a `tools` array, the bridge
  returns `501 not_implemented` with a clear message. The planner needs
  tool_use for any non-trivial task; this is the next milestone.
- **No SSE streaming.** The bridge is non-streaming only. Set
  `ARTEX_LLM_STREAM=false` in `.env` (the compose default does this).

## Setup

Already wired by `../docker-compose.yml`. On a fresh VPS:

```bash
# 1. Bring everything up. The bridge image builds Python + Node + the claude CLI.
cd ops/artex
docker compose up -d claude-bridge

# 2. One-time: log the container into your Claude Code account. The compose
#    file mounts ./claude-bridge-auth → /root/.claude so the login persists.
docker compose exec claude-bridge claude login
#    (follow the browser URL printed by the CLI)

# 3. Smoke test: /health should be 200 and /v1/messages should echo back.
curl -s http://127.0.0.1:5057/health | jq
curl -s http://127.0.0.1:5057/v1/messages \
  -H 'x-api-key: dummy' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Say ok"}]
  }' | jq

# 4. Bring the rest of ARTEX up. It will use the bridge by default.
docker compose up -d
```

## Env knobs

Set these in `../.env` (next to `docker-compose.yml`). All optional; defaults
work.

| var | default | what |
|-----|---------|------|
| `BRIDGE_MAX_RPS` | `1.0` | max LLM requests per second. 0 disables. |
| `BRIDGE_MAX_CONCURRENCY` | `2` | max LLM requests in flight. 0 disables. |
| `BRIDGE_CACHE_TTL_SECONDS` | `3600` | prompt cache TTL. 0 = always miss. |
| `BRIDGE_LOG_LEVEL` | `INFO` | `DEBUG` to see each prompt+response. |

Turn these UP only if you know your subscription window can absorb more;
ARTEX can fire the planner a few hundred times per task.

## Testing

```bash
cd ops/artex/claude-bridge
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest
```

30 tests covering wire shape, cache, rate limit, wiring, and the SDK adapter
(with the SDK mocked). The SDK is not exercised end-to-end here because that
requires a logged-in `claude` CLI; the `curl` smoke test above fills that gap.

## Known subscription-limit behaviour

The Claude Code subscription has two visible windows:

- **5-hour window**: dozens of prompts, soft reset.
- **7-day window**: hundreds of prompts, hard reset.

When either rejects, the SDK emits a `RateLimitEvent` with `status="rejected"`
or a terminal `ResultMessage` with `terminal_reason="rate_limit"`. The bridge
raises `SubscriptionRateLimited`, the route handler maps it to HTTP 429
`rate_limit_error`, and ARTEX pauses the task rather than crashing. Re-run the
task after the window resets, or lower the per-task turn budget in `.env`:

```
ARTEX_TASK_BUDGET_TURNS=30
ARTEX_INTENT_BUDGET_TURNS=10
```

## Auditability

Every request through the bridge is logged by uvicorn's access log. For full
prompt/response logging, set `BRIDGE_LOG_LEVEL=DEBUG`. ARTEX's own audit logs
in `/app/data` still record everything the planner decided to do.

## Going direct (bypass the bridge)

Comment the `ARTEX_LLM_BASE_URL` line in `../.env` and put a real
`ANTHROPIC_API_KEY=sk-ant-...` in its place. Compose will leave the bridge
service running but ARTEX will talk to Anthropic directly.
