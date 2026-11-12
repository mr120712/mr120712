// @polsia:user-owned — stato condiviso della chiave Anthropic, client SDK, classificazione degli
// errori e log. Un'unica fonte di verità per le funzioni AI premium ("Cerca con l'AI" e
// "Organizza con l'AI"): la chiave è ANTHROPIC_API_KEY (segreto server-side su Vercel), ogni
// richiesta è a carico del proprietario di Solco, e un problema di chiave/account rilevato da una
// funzione spegne anche l'altra (keyMemo è condiviso). Non logga mai la chiave, il prompt o la
// risposta.
import 'server-only';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

/** The Anthropic key; also accepts the common misspelling ANTHROPHIC_API_KEY. */
export function anthropicApiKey(env: Record<string, string | undefined> = process.env) {
  return env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPHIC_API_KEY?.trim() || undefined;
}

// A single attempt with a 100 s deadline always ends within the search route's 120 s limit, and a
// slow turn is never paid twice by an automatic retry. Long-context callers override this per
// request (streaming) with a far longer deadline.
export const AI_CLIENT_TIMEOUT_MS = 100_000;

let client: { key: string | undefined; sdk: Anthropic } | null = null;
/** The SDK client, rebuilt only when the configured key changes. */
export function anthropicClient() {
  const key = anthropicApiKey();
  if (!client || client.key !== key) {
    client = {
      key,
      sdk: new Anthropic({ apiKey: key, maxRetries: 0, timeout: AI_CLIENT_TIMEOUT_MS }),
    };
  }
  return client.sdk;
}

function logKeyShape(message: string, extra: Record<string, unknown> = {}) {
  // Shape of the configured key only (never its value), to diagnose a wrong or rejected key.
  const key = anthropicApiKey() ?? '';
  // biome-ignore lint/suspicious/noConsole: server log of the key's shape only (never its value).
  console.error(message, {
    length: key.length,
    standardKey: key.startsWith('sk-ant-api'),
    adminKey: key.startsWith('sk-ant-admin'),
    hasSpaces: /\s/.test(key),
    hasQuotes: /["'‘’“”«»]/.test(key),
    hasEquals: key.includes('='),
    nonAscii: /[^\x20-\x7e]/.test(key),
    ...extra,
  });
}

/** What the owner needs to diagnose a failed call: never the key, the prompt or the answer. */
function apiErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Anthropic.APIError)) {
    // Never the message or the cause: a bad header error from fetch repeats the key.
    return { errorName: error instanceof Error ? error.name : typeof error };
  }
  return {
    status: error.status ?? null,
    type: error.type ?? null,
    errorCode: error.errorCode ?? null,
    requestId: error.requestID ?? null,
    kind:
      error instanceof Anthropic.APIConnectionTimeoutError
        ? 'timeout'
        : error instanceof Anthropic.APIUserAbortError
          ? 'abort'
          : error instanceof Anthropic.APIConnectionError
            ? 'connection'
            : 'api',
    apiMessage: typeof error.apiMessage === 'string' ? error.apiMessage.slice(0, 200) : null,
  };
}

/** Server log for the owner (no key, prompt or answer). Shared by both AI features. */
export function logAiFailure(
  reason: string,
  error?: unknown,
  extra: Record<string, unknown> = {},
  level: 'error' | 'warn' = 'error',
) {
  const fields = error === undefined ? {} : apiErrorFields(error);
  // biome-ignore lint/suspicious/noConsole: server log for the owner (no key, prompt or answer).
  console[level]('[solco] AI search failed', { reason, ...fields, ...extra });
}

// ---- Owner-side problems hidden behind HTTP codes ---------------------------------------------
// Some failures are not "try again later": they are account/config problems only the owner can fix
// in the Anthropic Console. We map them to `not_configured` (the UI hides the feature) and remember
// the key as rejected, so listeners are neither charged nor told to "Riprova" for a call that will
// keep failing. SDK 1.8.0 fills `error.errorCode` from `response.error.details.error_code` for every
// APIError (core/error.ts), and a 429 carrying `enforced_spend_limit_reached` is an
// EnforcedSpendLimitReachedError (a RateLimitError subclass): `errorCode` is the reliable signal, so
// we branch on it, with the human-readable `apiMessage` only as a fallback if the code is ever absent.

/** 429 error codes that are a persistent owner-side stop (the monthly spend cap), not a passing spike. */
const PERSISTENT_RATE_CODES = new Set(['enforced_spend_limit_reached']);

/** A 429 that is the owner's spend limit (keeps 429-ing until raised), not transient load. */
function isPersistentRateLimit(error: InstanceType<typeof Anthropic.APIError>) {
  if (error.errorCode && PERSISTENT_RATE_CODES.has(error.errorCode)) return true;
  // Fallback only: if a future API drops the structured code, the message still names the spend cap.
  return (
    typeof error.apiMessage === 'string' && /spend limit|spending limit/i.test(error.apiMessage)
  );
}

/** 400 error codes that mean the org/credential is not set up for this request (never retry-fixable). */
const PERSISTENT_400_CODES = new Set([
  'organization_not_enrolled_in_beta',
  'organization_on_hold',
  'organization_type_not_supported',
]);
/** A 400 message naming a config/permission cause: the beta not enabled, or a model/beta the org can't use. */
const CONFIG_400_MESSAGE =
  /anthropic-beta|not enrolled|does not have access|access to this model|not available to your organization/i;

/**
 * A 400 is never retryable. Most are a bug on our side ("failed"), but the server-side-fallback beta
 * not being enabled for the org, or a model/beta the org cannot use, is a config problem only the
 * owner can fix. Reclassify only 400s we can positively identify; everything else stays "failed".
 */
function is400ConfigProblem(error: InstanceType<typeof Anthropic.APIError>) {
  if (error.errorCode && PERSISTENT_400_CODES.has(error.errorCode)) return true;
  if (error.type === 'billing_error' || error.type === 'permission_error') return true;
  return typeof error.apiMessage === 'string' && CONFIG_400_MESSAGE.test(error.apiMessage);
}

// ---- Is the key usable? -------------------------------------------------------------------
// Presence alone is not enough: a key with the wrong shape never authenticates, and a key that
// Anthropic rejected keeps failing. Neither is offered to listeners. Only a short fingerprint of
// the key is kept in memory (never the key); a new key has a new fingerprint, so it starts clean.

/** The monitor's `sk-ant-` rule, plus visible ASCII only (no spaces, newlines, typographic quotes). */
const KEY_SHAPE = /^sk-ant-[\x21-\x7e]+$/;
/** Admin API keys manage the organization; they never send messages. */
const NOT_A_MESSAGES_KEY = /^sk-ant-admin/;

// A 401 may be a key mid-rotation, so recheck it sooner; an owner-side config error (billing,
// permission, model/beta gating, spend cap) needs a Console fix, so hold it off longer.
const REJECTED_MS = 10 * 60 * 1000;
const CONFIG_REJECTED_MS = 30 * 60 * 1000;
const VERIFIED_MS = 30 * 60 * 1000;
const UNKNOWN_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 4_000;

type KeyVerdict = 'ok' | 'rejected' | 'unknown';
let keyMemo: { fingerprint: string; verdict: KeyVerdict; at: number; until: number } | null = null;
let probe: { fingerprint: string; promise: Promise<boolean> } | null = null;
let loggedShapeFor: string | null = null;

function fingerprint(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function remember(key: string, verdict: KeyVerdict, ms: number, now: number) {
  const fp = fingerprint(key);
  // Latest observation wins: a slow call that started earlier (older `now`) must never clobber a
  // verdict a newer call already recorded. This keeps probe and POST writes consistent without
  // reading the wall clock, so the deterministic `now` the callers pass still drives the window.
  if (keyMemo && keyMemo.fingerprint === fp && keyMemo.at > now) return;
  keyMemo = { fingerprint: fp, verdict, at: now, until: now + ms };
}

/** A successful call proves the key and account work: remember it so the UI keeps offering the feature. */
export function rememberKeyOk(key: string, now: number) {
  remember(key, 'ok', VERIFIED_MS, now);
}

function memoFor(key: string, now: number) {
  return keyMemo && keyMemo.fingerprint === fingerprint(key) && keyMemo.until > now
    ? keyMemo
    : null;
}

export function keyUsable(key: string | undefined, now: number): key is string {
  if (!key) return false;
  if (!KEY_SHAPE.test(key) || NOT_A_MESSAGES_KEY.test(key)) {
    // GET runs on every page view: one line per key and process is enough.
    const print = fingerprint(key);
    if (loggedShapeFor !== print) {
      loggedShapeFor = print;
      logKeyShape('[solco] Anthropic key has the wrong shape; AI search stays off');
    }
    return false;
  }
  return memoFor(key, now)?.verdict !== 'rejected';
}

/** Usable as far as this instance knows, without calling Anthropic. */
export function aiKeyConfigured(now = new Date()) {
  return keyUsable(anthropicApiKey(), now.getTime());
}

/**
 * Like `aiKeyConfigured`, but when this instance has not checked the key recently it asks Anthropic
 * once (GET /v1/models: free, the same check as the monitor). A network error, timeout, 429 or 5xx
 * is not a verdict on the key: the feature stays on (POST answers "busy" for those) and the key is
 * checked again a minute later.
 */
export async function aiKeyAvailable(now = new Date()) {
  const key = anthropicApiKey();
  if (!keyUsable(key, now.getTime())) return false;
  if (memoFor(key, now.getTime())) return true;
  return verifyKey(key, now.getTime());
}

function verifyKey(key: string, now: number) {
  const print = fingerprint(key);
  if (probe?.fingerprint === print) return probe.promise;
  // A POST that answered meanwhile knows better than this probe: `remember` keeps the newer verdict.
  const settle = (verdict: KeyVerdict, ms: number) => remember(key, verdict, ms, now);
  const promise = anthropicClient()
    .models.list({ limit: 1 }, { timeout: PROBE_TIMEOUT_MS, maxRetries: 0 })
    .then(() => {
      settle('ok', VERIFIED_MS);
      return true;
    })
    .catch((error: unknown) => {
      const status = error instanceof Anthropic.APIError ? error.status : undefined;
      if (status === 401 || status === 402 || status === 403) {
        logKeyShape('[solco] Anthropic key rejected', apiErrorFields(error));
        settle('rejected', status === 401 ? REJECTED_MS : CONFIG_REJECTED_MS);
        return false;
      }
      logAiFailure('key_check', error, {}, 'warn');
      settle('unknown', UNKNOWN_MS);
      return true;
    })
    .finally(() => {
      if (probe?.promise === promise) probe = null;
    });
  probe = { fingerprint: print, promise };
  return promise;
}

export type AiErrorOutcome = 'not_configured' | 'busy' | 'failed';

/**
 * Maps an SDK error from a Messages call to an outcome, and for owner-side config/billing problems
 * remembers the key as rejected (so the next listener is neither charged nor sent again). Logs the
 * right level for the owner; never logs the key, prompt or answer. `apiKey` is the key that made
 * the failing call (already proven present and well-shaped by `keyUsable`).
 */
export function classifyAnthropicError(
  error: unknown,
  apiKey: string,
  now: number,
): AiErrorOutcome {
  // Branch on the status: 402 has no SDK class of its own.
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  if (status === 401) {
    // A rejected key may just be mid-rotation: hide it, but recheck sooner than a config problem.
    logKeyShape('[solco] Anthropic key rejected', apiErrorFields(error));
    remember(apiKey, 'rejected', REJECTED_MS, now);
    return 'not_configured';
  }
  // Billing (402), permission (403), model not available to the org (404): fixed by the owner
  // in the Anthropic Console, never by trying again. Hidden for the config window, then rechecked.
  if (status === 402 || status === 403 || status === 404) {
    logAiFailure('account', error);
    remember(apiKey, 'rejected', CONFIG_REJECTED_MS, now);
    return 'not_configured';
  }
  // The monthly spend cap also arrives as 429, but it is an owner-side stop, not a passing spike:
  // treat it like an account problem instead of telling listeners to "Riprova tra poco" forever.
  if (error instanceof Anthropic.RateLimitError && isPersistentRateLimit(error)) {
    logAiFailure('account', error, { spendLimit: true });
    remember(apiKey, 'rejected', CONFIG_REJECTED_MS, now);
    return 'not_configured';
  }
  // A 400 we can identify as a config/permission problem (server-side-fallback beta not enabled,
  // or a model/beta the org cannot use) is also the owner's to fix: hide it, don't loop "Riprova".
  if (error instanceof Anthropic.APIError && status === 400 && is400ConfigProblem(error)) {
    logAiFailure('account', error, { badRequest: true });
    remember(apiKey, 'rejected', CONFIG_REJECTED_MS, now);
    return 'not_configured';
  }
  if (
    error instanceof Anthropic.RateLimitError ||
    // The parent class covers the timeout subclass too: every network/connection failure
    // (DNS, reset, TLS, wrapped "fetch failed") is transient, like a timeout — not "failed".
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.APIUserAbortError ||
    (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500)
  ) {
    logAiFailure('busy', error, {}, 'warn');
    return 'busy';
  }
  logAiFailure('failed', error);
  return 'failed';
}
