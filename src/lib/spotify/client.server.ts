// @polsia:user-owned — client della Spotify Web API (https://api.spotify.com/v1).
// - 401: un solo rinnovo del token e un nuovo tentativo.
// - 429: attende Retry-After (o 1 s, 2 s, 4 s con jitter se manca), al massimo 3 nuovi tentativi
//   e 15 s di attesa in tutto; poi SpotifyError 429 con retryAfter. Mai cicli stretti.
// - 429 con reason QUOTA_EXCEEDED (quota della modalità sviluppo): nessun nuovo tentativo, che
//   consumerebbe altra quota; SpotifyError 'quota_exceeded'.
// - Errori documentati nello schema OpenAPI (400, 401, 403, 404, 429, 5xx) → SpotifyError con il
//   messaggio di Spotify, per spiegarlo all'utente.
// I token non vengono mai registrati nei log né inclusi negli errori.
import 'server-only';
import { z } from 'zod';
import { SPOTIFY_API_BASE, spotifyJson } from '@/lib/spotify/config.server';

export type SpotifyErrorReason =
  | 'bad_request'
  | 'reauth'
  | 'scope_outdated'
  | 'not_allowlisted'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'unavailable'
  | 'timeout'
  | 'invalid_response';

export class SpotifyError extends Error {
  readonly status: number;
  readonly reason: SpotifyErrorReason;
  /** Spotify's own error message (cleaned, at most 200 characters), when it sent one. */
  readonly spotifyMessage: string | null;
  /** Seconds to wait before retrying (429 only; null for quota_exceeded without Retry-After). */
  readonly retryAfter: number | null;

  constructor(init: {
    status: number;
    reason: SpotifyErrorReason;
    spotifyMessage?: string | null;
    retryAfter?: number | null;
  }) {
    super(`Spotify request failed: ${init.status} ${init.reason}`);
    this.name = 'SpotifyError';
    this.status = init.status;
    this.reason = init.reason;
    this.spotifyMessage = init.spotifyMessage ?? null;
    this.retryAfter = init.retryAfter ?? null;
  }
}

/** Access token plus an optional refresher; spotifyFetch stores the refreshed token here. */
export type SpotifyAuth = { accessToken: string; refresh?: () => Promise<string> };

export type SpotifyFetchOptions = {
  /** Absolute time (ms since epoch) after which no request or wait may start. */
  deadline?: number;
};

export const SPOTIFY_MAX_RETRIES = 3;
export const SPOTIFY_MAX_TOTAL_WAIT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
/** Suggested wait when Spotify answers 429 without Retry-After and we give up. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);

export const NOT_ALLOWLISTED_MESSAGE =
  'Il tuo account Spotify non è ancora abilitato per Solco. Finché l’app Solco su Spotify è in modalità sviluppo può usarla al massimo 5 account autorizzati: chi gestisce Solco deve aggiungere l’email del tuo account Spotify nel Developer Dashboard di Spotify (Settings → User Management).';

/** Spotify's development-mode answer for users missing from the app's allowlist. */
const NOT_ALLOWLISTED_PATTERN =
  /may not be registered|not registered|allowlist|developer\.spotify\.com\/dashboard/i;
const SCOPE_PATTERN = /insufficient client scope|scope/i;

const ErrorBodySchema = z.object({
  error: z.object({
    status: z.number().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
  }),
});

/** `reason` of Spotify's development-mode quota answer (429; docs: concepts/quota-modes). */
const QUOTA_EXCEEDED_REASON = 'QUOTA_EXCEEDED';

/** True for Spotify's quota answer: {"error":{"status":429,"message":…,"reason":"QUOTA_EXCEEDED"}}. */
export function isQuotaExceededBody(body: unknown): boolean {
  const parsed = ErrorBodySchema.safeParse(body);
  return parsed.success && parsed.data.error.reason === QUOTA_EXCEEDED_REASON;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Retry-After in milliseconds: delay-seconds or an HTTP date; null when absent or invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d{1,7}$/.test(raw)) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** 1 s, 2 s, 4 s… with ±25 % jitter so parallel clients do not retry in lockstep. */
export function backoffDelay(retry: number, random: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS * 2 ** retry;
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Drops control characters, collapses spaces and caps the length of Spotify's messages. */
export function cleanSpotifyMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = '';
  for (const char of value.slice(0, 1_000)) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127 && !(code >= 0xd800 && code <= 0xdfff)) text += char;
    else text += ' ';
  }
  const cleaned = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
  return cleaned || null;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * fetch with Spotify's retry rules: 429 and 5xx are retried after Retry-After (or exponential
 * backoff), at most SPOTIFY_MAX_RETRIES times and SPOTIFY_MAX_TOTAL_WAIT_MS in all, never past
 * the deadline. A 429 QUOTA_EXCEEDED is returned at once: retrying would only spend more of the
 * exhausted quota. Returns the last response (possibly still 429/5xx) for the caller to map.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: SpotifyFetchOptions = {},
): Promise<Response> {
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let retries = 0;
  let waited = 0;
  const canWait = (delay: number) =>
    retries < SPOTIFY_MAX_RETRIES &&
    waited + delay <= SPOTIFY_MAX_TOTAL_WAIT_MS &&
    Date.now() + delay < deadline;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SpotifyError({ status: 504, reason: 'timeout' });
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
    } catch (error) {
      if (isAbortError(error)) throw new SpotifyError({ status: 504, reason: 'timeout' });
      const delay = backoffDelay(retries);
      if (!canWait(delay)) throw new SpotifyError({ status: 503, reason: 'unavailable' });
      await sleep(delay);
      waited += delay;
      retries += 1;
      continue;
    }
    if (response.status === 429) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if (isQuotaExceededBody(body)) return response;
    }
    if (response.status === 429 || RETRYABLE_SERVER_STATUSES.has(response.status)) {
      // Retry-After 0 or a date in the past would mean an immediate retry: never wait less than
      // the exponential backoff, so a misbehaving header cannot cause a tight loop.
      const delay = Math.max(
        parseRetryAfter(response.headers.get('retry-after')) ?? 0,
        backoffDelay(retries),
      );
      if (!canWait(delay)) return response;
      await response.body?.cancel().catch(() => undefined);
      await sleep(delay);
      waited += delay;
      retries += 1;
      continue;
    }
    return response;
  }
}

/** Retry-After in whole seconds (at least 1), or null when absent or invalid. */
function retryAfterSeconds(response: Response): number | null {
  const ms = parseRetryAfter(response.headers.get('retry-after'));
  return ms === null ? null : Math.max(1, Math.ceil(ms / 1000));
}

/** SpotifyError 'quota_exceeded' when `response` is Spotify's quota answer, else null. */
export function quotaExceededError(response: Response, body: unknown): SpotifyError | null {
  if (response.status !== 429) return null;
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success || parsed.data.error.reason !== QUOTA_EXCEEDED_REASON) return null;
  return new SpotifyError({
    status: 429,
    reason: 'quota_exceeded',
    spotifyMessage: cleanSpotifyMessage(parsed.data.error.message),
    retryAfter: retryAfterSeconds(response),
  });
}

async function readErrorBody(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

/** Maps a failed Web API response to a SpotifyError. */
export async function spotifyErrorFrom(response: Response, path: string): Promise<SpotifyError> {
  const body = await readErrorBody(response);
  const spotifyMessage = cleanSpotifyMessage(body?.message);
  const status = response.status;
  if (status === 401) return new SpotifyError({ status, reason: 'reauth', spotifyMessage });
  if (status === 403) {
    const message = spotifyMessage ?? '';
    if (NOT_ALLOWLISTED_PATTERN.test(message)) {
      return new SpotifyError({ status, reason: 'not_allowlisted', spotifyMessage });
    }
    // A token without the granted scopes is fixed by connecting again.
    if (SCOPE_PATTERN.test(message)) {
      return new SpotifyError({ status: 401, reason: 'reauth', spotifyMessage });
    }
    // The person's own library (/me/…) is always readable with the granted scopes: a 403 there
    // is the development-mode allowlist.
    if (path.startsWith('/me/') || path.startsWith('/me?')) {
      return new SpotifyError({ status, reason: 'not_allowlisted', spotifyMessage });
    }
    return new SpotifyError({ status, reason: 'forbidden', spotifyMessage });
  }
  if (status === 404) return new SpotifyError({ status, reason: 'not_found', spotifyMessage });
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response);
    if (body?.reason === QUOTA_EXCEEDED_REASON) {
      return new SpotifyError({ status, reason: 'quota_exceeded', spotifyMessage, retryAfter });
    }
    return new SpotifyError({
      status,
      reason: 'rate_limited',
      spotifyMessage,
      retryAfter: retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS,
    });
  }
  if (status >= 500) return new SpotifyError({ status, reason: 'unavailable', spotifyMessage });
  return new SpotifyError({ status, reason: 'bad_request', spotifyMessage });
}

/**
 * GET `path` (relative to https://api.spotify.com/v1) and returns the parsed JSON, unvalidated:
 * callers validate it with their own zod schema.
 */
export async function spotifyFetch(
  path: string,
  auth: SpotifyAuth,
  options: SpotifyFetchOptions = {},
): Promise<unknown> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid Spotify API path');
  let refreshed = false;
  for (;;) {
    const response = await fetchWithRetry(
      `${SPOTIFY_API_BASE}${path}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json' },
      },
      options,
    );
    if (response.status === 401 && !refreshed && auth.refresh) {
      await response.body?.cancel().catch(() => undefined);
      refreshed = true;
      auth.accessToken = await auth.refresh();
      continue;
    }
    if (!response.ok) throw await spotifyErrorFrom(response, path);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new SpotifyError({ status: 502, reason: 'invalid_response' });
    }
  }
}

/** A bare HTTP reason phrase ("Forbidden") adds nothing to the Italian explanation. */
const BARE_REASON_PHRASE =
  /^(?:bad request|unauthorized|forbidden|not found|internal server error|bad gateway|service unavailable|gateway timeout)\.?$/i;

function quoted(message: string | null) {
  return message && !BARE_REASON_PHRASE.test(message) ? ` (Spotify: “${message}”)` : '';
}

export type SpotifyErrorDescription = {
  status: number;
  error: string;
  message: string;
  retryAfterSeconds?: number;
};

/** Status, stable code and Italian message for a SpotifyError (or a generic 500). */
export function describeSpotifyError(error: unknown): SpotifyErrorDescription {
  if (!(error instanceof SpotifyError)) {
    return {
      status: 500,
      error: 'spotify_failed',
      message: 'Non è stato possibile completare l’operazione con Spotify. Riprova più tardi.',
    };
  }
  switch (error.reason) {
    case 'reauth':
      return {
        status: 401,
        error: 'spotify_reauth',
        message:
          'Il collegamento con Spotify è scaduto o è stato revocato. Ricollega Spotify per continuare.',
      };
    case 'scope_outdated':
      return {
        status: 401,
        error: 'spotify_scope_outdated',
        message:
          'Ricollega Spotify per vedere anche le playlist di cui sei collaboratore: il consenso che hai dato a Solco in precedenza non le include.',
      };
    case 'not_allowlisted':
      return { status: 403, error: 'spotify_not_allowlisted', message: NOT_ALLOWLISTED_MESSAGE };
    case 'forbidden':
      return {
        status: 403,
        error: 'spotify_forbidden',
        message: `Spotify consente di leggere solo le playlist che hai creato o di cui sei collaboratore${quoted(error.spotifyMessage)}.`,
      };
    case 'not_found':
      return {
        status: 404,
        error: 'spotify_not_found',
        message: `Spotify non ha trovato la playlist: potrebbe essere stata eliminata o resa privata${quoted(error.spotifyMessage)}.`,
      };
    case 'rate_limited': {
      const seconds = error.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS;
      return {
        status: 429,
        error: 'spotify_rate_limited',
        message: `Spotify sta limitando le richieste di Solco. Riprova tra ${seconds} secondi.`,
        retryAfterSeconds: seconds,
      };
    }
    case 'quota_exceeded':
      // The quota does not reset in seconds: suggest a wait only when Spotify sent Retry-After.
      return {
        status: 429,
        error: 'spotify_quota_exceeded',
        message: `Solco ha esaurito per ora le richieste a Spotify: l’app Solco su Spotify è in modalità sviluppo e può fare solo un numero limitato di richieste${quoted(error.spotifyMessage)}. Riprova più tardi.`,
        ...(error.retryAfter ? { retryAfterSeconds: error.retryAfter } : {}),
      };
    case 'timeout':
      return {
        status: 504,
        error: 'spotify_unavailable',
        message:
          'Spotify sta rispondendo troppo lentamente. Riprova tra poco, magari con meno playlist.',
      };
    case 'unavailable':
      return {
        status: 503,
        error: 'spotify_unavailable',
        message: `Spotify non risponde al momento${quoted(error.spotifyMessage)}. Riprova tra qualche minuto.`,
      };
    default:
      return {
        status: 502,
        error: 'spotify_error',
        message: `Spotify ha rifiutato la richiesta${quoted(error.spotifyMessage)}. Riprova più tardi.`,
      };
  }
}

/** Italian `{ error, message }` response for a SpotifyError (or a generic 500). */
export function spotifyErrorResponse(error: unknown): Response {
  if (!(error instanceof SpotifyError)) {
    // biome-ignore lint/suspicious/noConsole: server log of the error name only (no tokens).
    console.error('[spotify] unexpected error', error instanceof Error ? error.name : 'unknown');
  }
  const { status, ...body } = describeSpotifyError(error);
  return spotifyJson(
    body,
    status,
    body.retryAfterSeconds ? { 'Retry-After': String(body.retryAfterSeconds) } : {},
  );
}
