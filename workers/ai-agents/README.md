# Solco AI agents — performance review on Render

A Render **Cron Job** that reviews the live site's performance with AI agents. It has no public port
(nothing to attack from the internet) and only makes outbound calls.

Each run:

1. **Measures** the live site, with code, not AI: time to first byte and size of the main pages,
   every same-origin JS/CSS file, cache and compression headers, `sw.js`, and the APIs: `/health`,
   `/api/ai-reserve/health` and the **Render yt-dlp worker's** `/health`.
2. **7 specialist agents** each read only the measurements of their area: server response, cache
   and CDN, JavaScript, CSS and fonts, images, APIs and workers, HTML/mobile/PWA.
3. **1 lead agent** merges their reports into the 10 most useful fixes, ranked by impact.
4. Prints the report in the Render **Logs**, and sends it to **Telegram** if configured.

The agents only use the measurements they receive: no tools, no browsing, no invented numbers.

## Where the agents think (FreeLLMAPI)

| Order | Backend | Variable | Notes |
|---|---|---|---|
| 1 | **MWAPI** (`https://api.mwapi.dev/v1`), key 1 then key 2 | `MWAPI_API_KEY`, `MWAPI_API_KEY_2`, `MWAPI_MODEL` | Third-party AI gateway serving Claude models. The model is `claude-sonnet-5` unless `MWAPI_MODEL` says otherwise (`auto` picks one from `/v1/models`); if MWAPI refuses it, the next backend takes over. |
| 2 | **Your FreeLLMAPI**, private on Render | `FREELLMAPI_PRIVATE_URL` (+ `FREELLMAPI_PRIVATE_KEY`) | Uses your **license key**. A Render *private service* has no public URL. |
| 3 | **Solco's reserve** | `SOLCO_RESERVE_KEY` | `https://www.solcomusic.online/api/ai-reserve/v1` (Groq · Cerebras · OpenRouter). Same value as `FREELLMAPI_API_KEY` on Vercel. |

Security policy (`lib.mjs`, `backendPolicy`), checked before any request:

- the private backend must be a **single-label host** on Render's private network (for example
  `http://freellmapi:3001/v1`);
- the reserve must be **https on solcomusic.online**;
- MWAPI must be exactly **`https://api.mwapi.dev/v1`**;
- anything else (a public host, an IP such as `192.168.0.117`, `localhost`, URLs with credentials)
  is **refused**, so a key is never sent anywhere else.

Each backend gets two tries on 429/5xx/timeout and one on 400/401/403, then the next backend takes
over. With both MWAPI keys set, an exhausted first key hands over to the second.
Keys are removed from every log line (`redact`).

## Your FreeLLMAPI license key

The license unlocks **your FreeLLMAPI instance**. It goes into that instance's configuration, not
into Solco and not into this worker:

1. In `render.yaml`, uncomment the `freellmapi` private service. Fill in the Docker image and the
   license variable name from FreeLLMAPI's install guide; they are not guessed here.
2. In the Render dashboard, set the license as a **secret** on that service.
3. On `solco-ai-agents`, set:
   - `FREELLMAPI_PRIVATE_URL` to `http://freellmapi:3001/v1`;
   - `FREELLMAPI_PRIVATE_KEY` to the client API key your instance issues, if it requires one.

Without your instance, the worker uses Solco's reserve alone.

## Setup (Render dashboard)

1. Make sure the Blueprint that created the yt-dlp worker is synced, so `solco-ai-agents` appears.
   Otherwise go to **New → Blueprint** and pick this repo.
2. Under **Environment**, set `SOLCO_RESERVE_KEY` to the same value as `FREELLMAPI_API_KEY` on
   Vercel. Optionally set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
3. Press **Trigger Run** and read the **Logs**.

Render cron jobs are not on the free plan. `starter` is billed by the minutes the job actually runs
(a run takes about 1–3 minutes).

## Vercel firewall

Vercel's firewall can answer automated requests with its *Security Checkpoint*. The report flags
pages measured that way. If it hits `/api/ai-reserve/v1/*`, add a manual Vercel firewall rule that
**bypasses** the challenge for that path prefix. That endpoint already requires the Bearer key.

## Tests

```bash
node --test workers/ai-agents/agents.test.mjs
```

The tests fake every network call. Render's build runs them, so a broken worker never replaces a
working one.
