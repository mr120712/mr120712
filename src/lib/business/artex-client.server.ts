// @polsia:user-owned — HTTP client for the ARTEX pentest agent on the Hetzner VPS.
//
// How it reaches ARTEX:
//   • ARTEX runs on the operator's own VPS (Caddy fronts it with TLS over
//     https://<ipv4>.sslip.io; see ops/artex/).
//   • Auth is ARTEX's own JWT: POST /api/auth/login with {username:"ARTEX",
//     password:ARTEX_PASSWORD} returns a 7-day Bearer token.
//   • We cache the token in memory per serverless instance; on 401 we re-login.
//
// Scope right now: `statusSummary` only. `/artex status` from Telegram.
// Conversation-based chat is a follow-up (needs polling + agent config glue).

import 'server-only';
import { z } from 'zod';

type Env = Record<string, string | undefined>;

export function artexConfig(env: Env = process.env) {
  const url = env.ARTEX_URL?.trim().replace(/\/+$/, '');
  const password = env.ARTEX_PASSWORD?.trim();
  if (!url || !password) return null;
  if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url)) return null;
  if (password.length < 8) return null;
  return { url, password, username: env.ARTEX_USERNAME?.trim() || 'ARTEX' } as const;
}

const LoginResponse = z.object({ token: z.string().min(16) });

// Loose shape: every field is optional, so the SAME schema accepts both
// /api/stats (tasks + tokens, sometimes findings) and
// /api/exploration/findings/stats (findings only). Unknown keys pass through
// so an ARTEX upgrade that adds fields never breaks this.
const StatsResponse = z
  .object({
    tasks: z
      .object({ total: z.number().optional(), running: z.number().optional() })
      .partial()
      .optional(),
    findings: z
      .object({
        total: z.number().optional(),
        by_severity: z.record(z.string(), z.number()).optional(),
      })
      .partial()
      .optional(),
    tokens: z.object({ today: z.number().optional() }).partial().optional(),
  })
  .passthrough();

// Cached JWT per Node process. Serverless may use fresh instances every call,
// so this is a best-effort optimization; worst case, we log in on every call,
// which the rate-limiter on the Telegram command keeps bounded.
let cachedToken: { token: string; expiresAt: number } | null = null;
let inFlightLogin: Promise<string> | null = null;
const JWT_TTL_MS = 6 * 24 * 3_600_000; // treat as 6 days to stay comfortably within ARTEX's 7

async function login(
  config: NonNullable<ReturnType<typeof artexConfig>>,
  fetchImpl: typeof fetch,
  timeoutMs = 10_000,
): Promise<string> {
  // Single-flight: concurrent authed() callers (e.g. Promise.all of /stats +
  // /findings) share one login request instead of racing two and clobbering
  // each other's tokens.
  if (inFlightLogin) return inFlightLogin;
  inFlightLogin = (async () => {
    try {
      const res = await fetchImpl(`${config.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: config.username, password: config.password }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`login_${res.status}`);
      const body = (await res.json().catch(() => null)) as unknown;
      const parsed = LoginResponse.safeParse(body);
      if (!parsed.success) throw new Error('login_bad_response');
      cachedToken = { token: parsed.data.token, expiresAt: Date.now() + JWT_TTL_MS };
      return parsed.data.token;
    } finally {
      inFlightLogin = null;
    }
  })();
  return inFlightLogin;
}

async function authed<T>(
  config: NonNullable<ReturnType<typeof artexConfig>>,
  path: string,
  init: RequestInit,
  parse: (body: unknown) => T | null,
  fetchImpl: typeof fetch,
  timeoutMs = 15_000,
): Promise<T> {
  const call = async (token: string) => {
    const res = await fetchImpl(`${config.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false as const };
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json().catch(() => null)) as unknown;
    const value = parse(body);
    if (value == null) throw new Error('bad_response');
    return { ok: true as const, value };
  };

  let token =
    cachedToken && cachedToken.expiresAt > Date.now()
      ? cachedToken.token
      : await login(config, fetchImpl);
  let outcome = await call(token);
  if (!outcome.ok) {
    cachedToken = null;
    token = await login(config, fetchImpl);
    outcome = await call(token);
    if (!outcome.ok) throw new Error('unauthorized');
  }
  return outcome.value;
}

export type ArtexStatus = {
  tasks: { total: number; running: number };
  findings: { total: number; bySeverity: Record<string, number> };
  tokensToday: number | null;
};

export type ArtexOutcome =
  | { status: 'ok'; data: ArtexStatus }
  | { status: 'not_configured' }
  | { status: 'failed'; error: string; detail?: string };

/**
 * One-shot status snapshot for the Telegram /artex status command.
 * Combines /api/stats (tasks, today tokens) with /api/exploration/findings/stats
 * (findings totals). Both are owner-only via JWT auth.
 */
export async function artexStatus(
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ArtexOutcome> {
  const config = artexConfig(env);
  if (!config) return { status: 'not_configured' };
  try {
    const [stats, findings] = await Promise.all([
      authed(
        config,
        '/api/stats',
        { method: 'GET' },
        (body) => StatsResponse.safeParse(body).data ?? null,
        fetchImpl,
      ),
      authed(
        config,
        '/api/exploration/findings/stats',
        { method: 'GET' },
        (body) => StatsResponse.safeParse(body).data ?? null,
        fetchImpl,
      ).catch(() => null),
    ]);
    const tasksTotal = stats.tasks?.total ?? 0;
    const tasksRunning = stats.tasks?.running ?? 0;
    const bySeverity = findings?.findings?.by_severity ?? stats.findings?.by_severity ?? {};
    const findingsTotal =
      findings?.findings?.total ??
      stats.findings?.total ??
      Object.values(bySeverity).reduce((a, b) => a + b, 0);
    return {
      status: 'ok',
      data: {
        tasks: { total: tasksTotal, running: tasksRunning },
        findings: { total: findingsTotal, bySeverity },
        tokensToday: stats.tokens?.today ?? null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'unauthorized' || message.startsWith('login_')) {
      return { status: 'failed', error: 'unauthorized', detail: message };
    }
    return { status: 'failed', error: 'unreachable', detail: message };
  }
}

// ------------------------------------------------------------------ chat

// What we accept back from `POST /api/conversations`: just the id, ignore the rest.
const ConversationCreated = z
  .object({ id: z.number().int().positive(), agent_key: z.string().optional() })
  .passthrough();

// One row of the per-conversation activity stream. The agent emits many kinds —
// `thinking`, `tool_use`, `tool_result`, `text`, `result`. For Telegram we only
// surface the human-readable ones: `text` (assistant words) and `result` (final
// answer, when the engine emits one). Everything else is just progress noise.
const ActivityRow = z
  .object({
    seq: z.number().int(),
    worker: z.string(),
    kind: z.string(),
    summary: z.string().optional().default(''),
    detail: z.string().optional().default(''),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const ActivityPage = z.object({
  items: z.array(ActivityRow),
  cursor: z.number().int(),
  running: z.boolean(),
});

export type ArtexChatOutcome =
  | { status: 'ok'; reply: string; conversationId: number }
  | { status: 'not_configured' }
  | { status: 'failed'; error: string; detail?: string };

export type AskArtexOptions = {
  agentKey?: string;
  /** Hard ceiling on the whole flow (create + send + poll). Must sit under the Telegram route's maxDuration. */
  timeoutMs?: number;
  /** Interval between poll calls. Faster = more CPU + chattier logs. */
  pollIntervalMs?: number;
};

/**
 * One-shot chat: creates a fresh conversation, sends the message, polls until the
 * agent stops (or timeout). Returns the last assistant text seen. No state is kept
 * between calls — every Telegram /artex ask starts a new ARTEX conversation.
 */
export async function askArtex(
  question: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  options: AskArtexOptions = {},
): Promise<ArtexChatOutcome> {
  const config = artexConfig(env);
  if (!config) return { status: 'not_configured' };
  const q = question.trim();
  if (!q) return { status: 'failed', error: 'empty_question' };

  const agentKey = options.agentKey ?? env.ARTEX_CHAT_AGENT_KEY?.trim() ?? 'auto';
  const timeoutMs = options.timeoutMs ?? 50_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  try {
    // 1. Create a conversation bound to the chat agent.
    const conv = await authed(
      config,
      '/api/conversations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_key: agentKey, title: 'Telegram /artex' }),
      },
      (body) => ConversationCreated.safeParse(body).data ?? null,
      fetchImpl,
      15_000,
    );

    // 2. Send the question. ARTEX returns immediately; the agent runs async.
    await authed(
      config,
      `/api/conversations/${conv.id}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: q }),
      },
      () => ({ ok: true }),
      fetchImpl,
      15_000,
    );

    // 3. Poll the activity stream until `running` flips to false or we time out.
    //    Keep the latest assistant `text`/`result` seen; that's what we return.
    let cursor = 0;
    let lastAssistantText = '';
    let lastKind = '';
    let running = true;
    while (Date.now() < deadline && running) {
      const remaining = Math.max(2_000, deadline - Date.now());
      const page = await authed(
        config,
        `/api/conversations/${conv.id}/messages?since=${cursor}`,
        { method: 'GET' },
        (body) => ActivityPage.safeParse(body).data ?? null,
        fetchImpl,
        Math.min(10_000, remaining),
      );
      cursor = page.cursor;
      running = page.running;
      for (const item of page.items) {
        if (item.worker === 'user') continue;
        if (item.kind !== 'text' && item.kind !== 'result') continue;
        const text = (item.detail || item.summary).trim();
        if (!text) continue;
        // A later 'result' always wins; otherwise keep the latest 'text'.
        if (item.kind === 'result' || lastKind !== 'result') {
          lastAssistantText = text;
          lastKind = item.kind;
        }
      }
      if (!running) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (running) {
      // Time ran out before ARTEX finished.
      return {
        status: 'failed',
        error: 'still_running',
        detail: `conversation ${conv.id}`,
      };
    }
    if (!lastAssistantText) {
      return { status: 'failed', error: 'empty_reply', detail: `conversation ${conv.id}` };
    }
    return { status: 'ok', reply: lastAssistantText, conversationId: conv.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'unauthorized' || message.startsWith('login_')) {
      return { status: 'failed', error: 'unauthorized', detail: message };
    }
    return { status: 'failed', error: 'unreachable', detail: message };
  }
}

/** Reset the in-memory token (for tests). Production has nothing to do here. */
export function _resetArtexAuth(): void {
  cachedToken = null;
  inFlightLogin = null;
}
