// @polsia:user-owned — ricerca musicale con Claude Opus 5.5 (SDK ufficiale Anthropic).
// La chiave è ANTHROPIC_API_KEY (segreto server-side su Vercel): ogni richiesta è a carico del
// proprietario di Solco, quindi la route richiede l'accesso, limita la frequenza e riusa i piani.
import 'server-only';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Prisma } from '@prisma/client';
import * as z from 'zod/v4';
import {
  AI_SEARCH_MODEL,
  AI_SEARCH_SYSTEM_PROMPT,
  aiSearchEffort,
  normalizePrompt,
  sanitizePlan,
} from '@/lib/business/ai-music-search';
import {
  AI_SEARCH_EXAMPLES,
  type AiSearchPlan,
  AiSearchPlanSchema,
} from '@/lib/contracts/ai-music-search';
import { prisma } from '@/lib/db';

const PLAN_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// What Claude must return (structured output). Limits live in the prompt and in sanitizePlan.
const ClaudePlan = z.object({
  intro: z.string().describe('One or two warm sentences in Italian about what you searched for'),
  youtubeQueries: z.array(z.string()).describe('At most 2 precise YouTube music searches'),
  audioQueries: z.array(z.string()).describe('At most 2 short genre/mood searches for Audius'),
  radioTags: z.array(z.string()).describe('Up to 3 lowercase Radio Browser tags'),
  podcastQuery: z.string().nullable().describe('One podcast search, or null'),
  genres: z.array(z.string()).describe('Up to 4 slugs from the Solco genre list'),
});

/** The Anthropic key; also accepts the common misspelling ANTHROPHIC_API_KEY. */
export function anthropicApiKey(env: Record<string, string | undefined> = process.env) {
  return env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPHIC_API_KEY?.trim() || undefined;
}

export type AiSearchOutcome =
  | { ok: true; plan: AiSearchPlan; cached: boolean }
  | { ok: false; error: 'not_configured' | 'refused' | 'busy' | 'failed' };

const SHARED_PROMPTS = new Set(AI_SEARCH_EXAMPLES.map((example) => normalizePrompt(example)));

/**
 * Plans are private to the listener who asked (nobody can probe what others searched);
 * only the ready-made examples are shared, since everyone sees those texts anyway.
 */
export function aiSearchCacheKey(prompt: string, userId: string) {
  const text = normalizePrompt(prompt);
  const scope = SHARED_PROMPTS.has(text) ? 'shared' : `user:${userId}`;
  return {
    key: createHash('sha256').update(`${scope}\n${text}`).digest('hex'),
    owner: SHARED_PROMPTS.has(text) ? null : userId,
  };
}

async function readCache(key: string, now: Date) {
  try {
    const row = await prisma.aiMusicSearchCache.findUnique({ where: { key } });
    if (!row || row.expiresAt <= now) return null;
    const parsed = AiSearchPlanSchema.safeParse(row.payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, owner: string | null, plan: AiSearchPlan, now: Date) {
  const data = {
    userId: owner,
    payload: plan as unknown as Prisma.InputJsonValue,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PLAN_CACHE_MS),
  };
  await Promise.resolve()
    .then(() =>
      prisma.aiMusicSearchCache.upsert({ where: { key }, create: { key, ...data }, update: data }),
    )
    .catch(() => undefined);
  // Keep the promise in the privacy policy: nothing older than 7 days stays stored.
  await Promise.resolve()
    .then(() => prisma.aiMusicSearchCache.deleteMany({ where: { expiresAt: { lte: now } } }))
    .catch(() => undefined);
}

// The route allows 120 s: a single attempt with a 100 s deadline always ends in time, and a
// slow turn is never paid twice by an automatic retry.
const REQUEST_TIMEOUT_MS = 100_000;

let client: { key: string | undefined; sdk: Anthropic } | null = null;
function anthropic() {
  const key = anthropicApiKey();
  if (!client || client.key !== key) {
    client = {
      key,
      sdk: new Anthropic({ apiKey: key, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS }),
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
    hasQuotes: /["'\u2018\u2019\u201c\u201d\u00ab\u00bb]/.test(key),
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

function logAiSearchFailure(
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

function memoFor(key: string, now: number) {
  return keyMemo && keyMemo.fingerprint === fingerprint(key) && keyMemo.until > now
    ? keyMemo
    : null;
}

function keyUsable(key: string | undefined, now: number): key is string {
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
export function aiSearchConfigured(now = new Date()) {
  return keyUsable(anthropicApiKey(), now.getTime());
}

/**
 * What GET tells the client. Like `aiSearchConfigured`, and when this instance has not checked
 * the key recently, asks Anthropic once (GET /v1/models: free, the same check as the monitor).
 * A network error, timeout, 429 or 5xx is not a verdict on the key: the search stays on (POST
 * answers "busy" for those) and the key is checked again a minute later.
 */
export async function aiSearchAvailable(now = new Date()) {
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
  const promise = anthropic()
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
      logAiSearchFailure('key_check', error, {}, 'warn');
      settle('unknown', UNKNOWN_MS);
      return true;
    })
    .finally(() => {
      if (probe?.promise === promise) probe = null;
    });
  probe = { fingerprint: print, promise };
  return promise;
}

/** Reads the structured plan; null when the text is not a valid plan. */
function readPlan(response: Anthropic.Beta.BetaMessage) {
  const text = response.content.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') return null;
  try {
    const parsed = ClaudePlan.safeParse(JSON.parse(text.text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function planMusicSearch(
  prompt: string,
  userId: string,
  now = new Date(),
): Promise<AiSearchOutcome> {
  const apiKey = anthropicApiKey();
  // A key with the wrong shape, or rejected minutes ago, is not tried (and not paid) again.
  if (!keyUsable(apiKey, now.getTime())) return { ok: false, error: 'not_configured' };
  const { key, owner } = aiSearchCacheKey(prompt, userId);
  const cached = await readCache(key, now);
  if (cached) return { ok: true, plan: cached, cached: true };

  try {
    // `create` (not `parse`): a refusal can carry partial text, which `parse` would throw on
    // before stop_reason could be checked.
    const response = await anthropic().beta.messages.create(
      {
        model: AI_SEARCH_MODEL,
        max_tokens: 16000,
        // A safety decline on Opus 5.5 is retried server-side on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          { type: 'text', text: AI_SEARCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        output_config: {
          effort: aiSearchEffort(process.env.SOLCO_AI_SEARCH_EFFORT),
          format: betaZodOutputFormat(ClaudePlan),
        },
        messages: [
          {
            role: 'user',
            content: `Descrizione dell'ascoltatore:\n<descrizione>\n${prompt}\n</descrizione>`,
          },
        ],
      },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 5_000) },
    );
    // Any answer means the key and the account work.
    remember(apiKey, 'ok', VERIFIED_MS, now.getTime());
    const requestId = response._request_id ?? null;
    if (response.stop_reason === 'refusal') {
      logAiSearchFailure(
        'refusal',
        undefined,
        { category: response.stop_details?.category ?? null, requestId },
        'warn',
      );
      return { ok: false, error: 'refused' };
    }
    if (response.stop_reason !== 'end_turn') {
      logAiSearchFailure('stop_reason', undefined, {
        stopReason: response.stop_reason,
        model: response.model,
        usage: response.usage,
        requestId,
      });
      return { ok: false, error: 'failed' };
    }
    const raw = readPlan(response);
    if (!raw) {
      logAiSearchFailure('invalid_plan', undefined, {
        model: response.model,
        blocks: response.content.map((block) => block.type),
        requestId,
      });
      return { ok: false, error: 'failed' };
    }
    const plan = sanitizePlan(raw);
    await writeCache(key, owner, plan, now);
    return { ok: true, plan, cached: false };
  } catch (error) {
    // Branch on the status: 402 has no SDK class of its own.
    const status = error instanceof Anthropic.APIError ? error.status : undefined;
    if (status === 401) {
      // A rejected key may just be mid-rotation: hide it, but recheck sooner than a config problem.
      logKeyShape('[solco] Anthropic key rejected', apiErrorFields(error));
      remember(apiKey, 'rejected', REJECTED_MS, now.getTime());
      return { ok: false, error: 'not_configured' };
    }
    // Billing (402), permission (403), model not available to the org (404): fixed by the owner
    // in the Anthropic Console, never by trying again. Hidden for the config window, then rechecked.
    if (status === 402 || status === 403 || status === 404) {
      logAiSearchFailure('account', error);
      remember(apiKey, 'rejected', CONFIG_REJECTED_MS, now.getTime());
      return { ok: false, error: 'not_configured' };
    }
    // The monthly spend cap also arrives as 429, but it is an owner-side stop, not a passing spike:
    // treat it like an account problem instead of telling listeners to "Riprova tra poco" forever.
    if (error instanceof Anthropic.RateLimitError && isPersistentRateLimit(error)) {
      logAiSearchFailure('account', error, { spendLimit: true });
      remember(apiKey, 'rejected', CONFIG_REJECTED_MS, now.getTime());
      return { ok: false, error: 'not_configured' };
    }
    // A 400 we can identify as a config/permission problem (server-side-fallback beta not enabled,
    // or a model/beta the org cannot use) is also the owner's to fix: hide it, don't loop "Riprova".
    if (error instanceof Anthropic.APIError && status === 400 && is400ConfigProblem(error)) {
      logAiSearchFailure('account', error, { badRequest: true });
      remember(apiKey, 'rejected', CONFIG_REJECTED_MS, now.getTime());
      return { ok: false, error: 'not_configured' };
    }
    if (
      error instanceof Anthropic.RateLimitError ||
      // The parent class covers the timeout subclass too: every network/connection failure
      // (DNS, reset, TLS, wrapped "fetch failed") is transient, like a timeout — not "failed".
      error instanceof Anthropic.APIConnectionError ||
      error instanceof Anthropic.APIUserAbortError ||
      (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500)
    ) {
      logAiSearchFailure('busy', error, {}, 'warn');
      return { ok: false, error: 'busy' };
    }
    logAiSearchFailure('failed', error);
    return { ok: false, error: 'failed' };
  }
}
