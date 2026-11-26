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
- **Tool use passthrough.** When ARTEX sends `tools: [...]`, the bridge
  registers each one as an in-process Claude SDK MCP tool, captures the
  model's `tool_use` decision from the agent stream (before the SDK can
  "execute" the no-op handler), strips the `mcp__artex__` prefix, and returns
  a canonical Anthropic `tool_use` content block with `stop_reason: tool_use`.
  ARTEX executes the tool on its side exactly as with the real API, then
  sends the next turn's conversation (including the prior `tool_use` and
  its `tool_result`) back here — the bridge flattens the loop into a text
  prompt the model can continue from.
- Caches identical prompts (including the tools catalog) in SQLite so a
  retry is free.
- Rate-limits locally (RPS + in-flight) to protect the subscription window.
- Surfaces subscription rate-limit rejections as HTTP 429 `rate_limit_error`,
  which ARTEX treats as a transient fault.

## What it does NOT do (yet)

- **Lossy agent-loop replay.** When ARTEX sends the Nth follow-up, the bridge
  flattens the whole prior conversation (including tool_use/tool_result
  blocks) into a readable text prompt. The model sees this as context and
  decides the next step; it is not bit-identical to a native Anthropic API
  multi-turn session. For long loops you may see planner drift. Mitigation:
  keep `ARTEX_TASK_BUDGET_TURNS` moderate.

## Streaming (SSE)

`stream: true` is supported. The bridge collects the whole adapter response
first and then emits the Anthropic SSE event sequence — `message_start`,
`content_block_start/delta/stop` per block (text chunked as `text_delta`,
tool_use serialized as `input_json_delta`), `message_delta`, `message_stop`.
Rate-limit mid-stream becomes `event: error` on a 200 body, which ARTEX's Go
client reads as a transient fault.

**This is a fake stream**: there is NO latency win over the non-streaming
path because we already have the full response when we start sending frames.
The point is wire-protocol compatibility so ARTEX's SSE-reading code path
works unchanged. You can leave `ARTEX_LLM_STREAM=true` if you prefer; the
default we ship is `false` because it's a smaller surface for first debug.

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

53 unit tests covering wire shape, tool_use passthrough, SSE streaming
(text + tool_use chunking, error frame), cache, rate limit, wiring, schema
normalizers (including the tool_use + tool_result flattening), and the SDK
adapter (with the SDK mocked). The adapter tests include one regression for
`tools=[]` (no CLI built-ins leak into the model's catalog) and one for
the token-accounting floor (SDK reports per-turn deltas; we floor usage at
our own chars/4 prompt estimate so ARTEX_TASK_BUDGET_TOKENS actually trips).

### Live integration tests

4 additional tests under `tests/integration/` actually spawn the real
`claude` CLI through the Claude Agent SDK and hit the user's Claude Code
subscription. They are **excluded by default** (pyproject uses
`-m 'not integration'`). To run them:

```bash
# 1. Install and log into the Claude Code CLI on this host:
claude login

# 2. Run the live suite. Each test uses haiku + tiny max_tokens; cost is a
#    few dozen tokens total. Full run is ~30s wall time.
ARTEX_BRIDGE_LIVE_TESTS=1 pytest -m integration
```

Coverage:

- `test_live_adapter_text_only_completion` — adapter → CLI → text reply
- `test_live_adapter_tool_use_decision` — adapter with ARTEX tools; model
  emits `tool_use`, bridge strips the `mcp__artex__` prefix, returns the
  native Anthropic shape. The live run also lets the test catch the
  dangerous case where CLI built-in tools (Bash, Read, ToolSearch, ...)
  leak into the model's tool list; the bridge sets `tools=[]` to keep
  only MCP-registered tools visible. A matching unit regression test
  (`test_cli_builtin_tools_are_disabled`) locks that in.
- `test_live_http_bridge_text_roundtrip` — full FastAPI route +
  real SDK for text
- `test_live_http_bridge_stream_roundtrip` — full SSE path with the
  real SDK (reads message_start, content_block_delta frames, message_stop)

Override the model via `ARTEX_BRIDGE_LIVE_MODEL=claude-sonnet-...` when
you want to test against a different account tier.

To drill the tool_use path end-to-end, a representative POST looks like:

```bash
curl -s http://127.0.0.1:5057/v1/messages \
  -H 'x-api-key: dummy' \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "system": "You are a pentesting planner. Call http_get to probe.",
    "messages": [{"role":"user","content":"Probe example.test/health"}],
    "tools": [{
      "name": "http_get",
      "description": "Fetch a URL and return headers + body",
      "input_schema": {
        "type":"object",
        "properties": {"url":{"type":"string"}},
        "required": ["url"]
      }
    }]
  }' | jq
```

Expected: `stop_reason: "tool_use"`, `content` including
`{"type":"tool_use","id":"...","name":"http_get","input":{"url":"..."}}`.

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
