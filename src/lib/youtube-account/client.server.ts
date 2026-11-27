// @polsia:user-owned — client della YouTube Data API v3 (https://www.googleapis.com/youtube/v3),
// autenticato con il token OAuth dell'utente.
// - 401: un solo rinnovo del token e un nuovo tentativo.
// - 429 / 403 rateLimitExceeded: attende Retry-After (o backoff), max 3 tentativi, 15 s in tutto.
// - 403 quotaExceeded/dailyLimitExceeded: nessun nuovo tentativo; YouTubeError 'quota_exceeded'.
// I token non vengono mai registrati nei log né inclusi negli errori. Pattern speculare al client
// Spotify (src/lib/spotify/client.server.ts); gli helper puri parseRetryAfter/backoffDelay/
// cleanProviderMessage sono riusati da lì.
import 'server-only';
import { z } from 'zod';
import {
  backoffDelay,
  cleanSpotifyMessage as cleanProviderMessage,
  parseRetryAfter,
} from '@/lib/spotify/client.server';
import { YOUTUBE_API_BASE, youtubeJson } from '@/lib/youtube-account/config.server';

export type YouTubeErrorReason =
  | 'bad_request'
  | 'reauth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'unavailable'
  | 'timeout'
  | 'invalid_response';

export class YouTubeError extends Error {
  readonly status: number;
  readonly reason: YouTubeErrorReason;
  readonly providerMessage: string | null;
  readonly retryAfter: number | null;

  constructor(init: {
    status: number;
    reason: YouTubeErrorReason;
    providerMessage?: string | null;
    retryAfter?: number | null;
  }) {
    super(`YouTube request failed: ${init.status} ${init.reason}`);
    this.name = 'YouTubeError';
    this.status = init.status;
    this.reason = init.reason;
    this.providerMessage = init.providerMessage ?? null;
    this.retryAfter = init.retryAfter ?? null;
  }
}

/** Access token plus an optional refresher; youtubeFetch stores the refreshed token here. */
export type YouTubeAuth = { accessToken: string; refresh?: () => Promise<string> };

export type YouTubeFetchOptions = {
  /** Absolute time (ms since epoch) after which no request or wait may start. */
  deadline?: number;
};

export const YOUTUBE_MAX_RETRIES = 3;
export const YOUTUBE_MAX_TOTAL_WAIT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);

/** Google Data API error body: { error: { code, message, errors: [{ reason, ... }] } }. */
const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z
      .array(z.object({ reason: z.string().optional(), message: z.string().optional() }))
      .optional(),
  }),
});

/** Reasons Google uses when the daily quota is spent (403, docs: Data API quota). */
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
/** Short-term rate limiting (retryable). */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function firstReason(body: unknown): string | null {
  const parsed = ApiErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.error.errors?.find((e) => e.reason)?.reason ?? null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** fetch with YouTube's retry rules: 429 and 5xx retried with backoff; a 403 quota is returned at once. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: YouTubeFetchOptions = {},
): Promise<Response> {
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let retries = 0;
  let waited = 0;
  const canWait = (delay: number) =>
    retries < YOUTUBE_MAX_RETRIES &&
    waited + delay <= YOUTUBE_MAX_TOTAL_WAIT_MS &&
    Date.now() + delay < deadline;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new YouTubeError({ status: 504, reason: 'timeout' });
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
    } catch (error) {
      if (isAbortError(error)) throw new YouTubeError({ status: 504, reason: 'timeout' });
      const delay = backoffDelay(retries);
      if (!canWait(delay)) throw new YouTubeError({ status: 503, reason: 'unavailable' });
      await sleep(delay);
      waited += delay;
      retries += 1;
      continue;
    }
    // A spent daily quota (403 quotaExceeded) must not be retried: it would change nothing.
    if (response.status === 403) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const reason = firstReason(body);
      if (reason && QUOTA_REASONS.has(reason)) return response;
      if (reason && RATE_LIMIT_REASONS.has(reason)) {
        const delay = backoffDelay(retries);
        if (!canWait(delay)) return response;
        await response.body?.cancel().catch(() => undefined);
        await sleep(delay);
        waited += delay;
        retries += 1;
        continue;
      }
      return response;
    }
    if (response.status === 429 || RETRYABLE_SERVER_STATUSES.has(response.status)) {
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

function retryAfterSeconds(response: Response): number | null {
  const ms = parseRetryAfter(response.headers.get('retry-after'));
  return ms === null ? null : Math.max(1, Math.ceil(ms / 1000));
}

/** Maps a failed Data API response to a YouTubeError. */
export async function youtubeErrorFrom(response: Response): Promise<YouTubeError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ApiErrorBodySchema.safeParse(body);
  const providerMessage = cleanProviderMessage(parsed.success ? parsed.data.error.message : null);
  const reason = firstReason(body);
  const status = response.status;
  if (status === 401) return new YouTubeError({ status, reason: 'reauth', providerMessage });
  if (status === 403) {
    if (reason && QUOTA_REASONS.has(reason)) {
      return new YouTubeError({
        status: 429,
        reason: 'quota_exceeded',
        providerMessage,
        retryAfter: retryAfterSeconds(response),
      });
    }
    if (reason && RATE_LIMIT_REASONS.has(reason)) {
      return new YouTubeError({
        status: 429,
        reason: 'rate_limited',
        providerMessage,
        retryAfter: retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS,
      });
    }
    return new YouTubeError({ status, reason: 'forbidden', providerMessage });
  }
  if (status === 404) return new YouTubeError({ status, reason: 'not_found', providerMessage });
  if (status === 429) {
    return new YouTubeError({
      status,
      reason: 'rate_limited',
      providerMessage,
      retryAfter: retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS,
    });
  }
  if (status >= 500) return new YouTubeError({ status, reason: 'unavailable', providerMessage });
  return new YouTubeError({ status, reason: 'bad_request', providerMessage });
}

/**
 * GET `path` (relative to the Data API base) with the user's bearer token, returning parsed JSON
 * unvalidated: callers validate with their own zod schema. On 401, refreshes once and retries.
 */
export async function youtubeFetch(
  path: string,
  auth: YouTubeAuth,
  options: YouTubeFetchOptions = {},
): Promise<unknown> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid YouTube API path');
  let refreshed = false;
  for (;;) {
    const response = await fetchWithRetry(
      `${YOUTUBE_API_BASE}${path}`,
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
    if (!response.ok) throw await youtubeErrorFrom(response);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new YouTubeError({ status: 502, reason: 'invalid_response' });
    }
  }
}

const BARE_REASON_PHRASE =
  /^(?:bad request|unauthorized|forbidden|not found|internal server error|bad gateway|service unavailable|gateway timeout)\.?$/i;

function quoted(message: string | null) {
  return message && !BARE_REASON_PHRASE.test(message) ? ` (YouTube: “${message}”)` : '';
}

export type YouTubeErrorDescription = {
  status: number;
  error: string;
  message: string;
  retryAfterSeconds?: number;
};

/** Status, stable code and Italian message for a YouTubeError (or a generic 500). */
export function describeYouTubeError(error: unknown): YouTubeErrorDescription {
  if (!(error instanceof YouTubeError)) {
    return {
      status: 500,
      error: 'youtube_failed',
      message: 'Non è stato possibile completare l’operazione con YouTube. Riprova più tardi.',
    };
  }
  switch (error.reason) {
    case 'reauth':
      return {
        status: 401,
        error: 'youtube_reauth',
        message:
          'Il collegamento con YouTube è scaduto o è stato revocato. Ricollega YouTube per continuare.',
      };
    case 'forbidden':
      return {
        status: 403,
        error: 'youtube_forbidden',
        message: `YouTube ha negato l’accesso a questa risorsa${quoted(error.providerMessage)}.`,
      };
    case 'not_found':
      return {
        status: 404,
        error: 'youtube_not_found',
        message: `YouTube non ha trovato la playlist: potrebbe essere stata eliminata${quoted(error.providerMessage)}.`,
      };
    case 'rate_limited': {
      const seconds = error.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS;
      return {
        status: 429,
        error: 'youtube_rate_limited',
        message: `YouTube sta limitando le richieste di Solco. Riprova tra ${seconds} secondi.`,
        retryAfterSeconds: seconds,
      };
    }
    case 'quota_exceeded':
      return {
        status: 429,
        error: 'youtube_quota_exceeded',
        message: `Solco ha esaurito per oggi la quota della YouTube Data API${quoted(error.providerMessage)}. Riprova domani.`,
        ...(error.retryAfter ? { retryAfterSeconds: error.retryAfter } : {}),
      };
    case 'timeout':
      return {
        status: 504,
        error: 'youtube_unavailable',
        message:
          'YouTube sta rispondendo troppo lentamente. Riprova tra poco, magari con meno playlist.',
      };
    case 'unavailable':
      return {
        status: 503,
        error: 'youtube_unavailable',
        message: `YouTube non risponde al momento${quoted(error.providerMessage)}. Riprova tra qualche minuto.`,
      };
    default:
      return {
        status: 502,
        error: 'youtube_error',
        message: `YouTube ha rifiutato la richiesta${quoted(error.providerMessage)}. Riprova più tardi.`,
      };
  }
}

/** Italian `{ error, message }` response for a YouTubeError (or a generic 500). */
export function youtubeErrorResponse(error: unknown): Response {
  if (!(error instanceof YouTubeError)) {
    // biome-ignore lint/suspicious/noConsole: server log of the error name only (no tokens).
    console.error('[youtube] unexpected error', error instanceof Error ? error.name : 'unknown');
  }
  const { status, ...body } = describeYouTubeError(error);
  return youtubeJson(
    body,
    status,
    body.retryAfterSeconds ? { 'Retry-After': String(body.retryAfterSeconds) } : {},
  );
}
