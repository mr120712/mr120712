// @polsia:user-owned — chiamate all'API TikTok v2 (OAuth token endpoint form-encoded; endpoint
// Content Posting con envelope { data, error }). Classificazione degli errori in motivi stabili;
// mai il token né il client_secret nei log o nelle risposte.
import 'server-only';

export type TikTokErrorReason =
  | 'reauth'
  | 'rate_limited'
  | 'unavailable'
  | 'bad_request'
  | 'invalid_response'
  | 'forbidden'
  | 'scope_not_authorized'
  | 'url_ownership_unverified'
  | 'privacy_level_mismatch'
  | 'unaudited_public'
  | 'spam_risk'
  | 'network';

export class TikTokError extends Error {
  readonly status: number;
  readonly reason: TikTokErrorReason;
  /** Il codice d'errore di TikTok (mai dati sensibili), utile a diagnosticare. */
  readonly tiktokCode: string | null;
  constructor(init: { status: number; reason: TikTokErrorReason; tiktokCode?: string | null }) {
    super(`tiktok_${init.reason}`);
    this.name = 'TikTokError';
    this.status = init.status;
    this.reason = init.reason;
    this.tiktokCode = init.tiktokCode ?? null;
  }
}

const DEFAULT_DEADLINE_MS = 20_000;

function signalFor(deadline?: number): AbortSignal | undefined {
  const ms =
    typeof deadline === 'number' ? Math.max(1, deadline - Date.now()) : DEFAULT_DEADLINE_MS;
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** POST form-encoded al token endpoint. Ritorna status + body JSON (o null). Non lancia sulla rete. */
export async function postForm(
  url: string,
  params: Record<string, string>,
  deadline?: number,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      },
      body: new URLSearchParams(params).toString(),
      cache: 'no-store',
      signal: signalFor(deadline),
    });
  } catch {
    throw new TikTokError({ status: 503, reason: 'network' });
  }
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

/** Mappa il codice d'errore Content Posting di TikTok su un motivo stabile. */
function reasonForCode(status: number, code: string | null): TikTokErrorReason {
  switch (code) {
    case 'rate_limit_exceeded':
      return 'rate_limited';
    case 'access_token_invalid':
    case 'token_not_found':
      return 'reauth';
    case 'scope_not_authorized':
    case 'scope_permission_missed':
      return 'scope_not_authorized';
    case 'url_ownership_unverified':
      return 'url_ownership_unverified';
    case 'privacy_level_option_mismatch':
      return 'privacy_level_mismatch';
    case 'unaudited_client_can_only_post_to_private_accounts':
      return 'unaudited_public';
    case 'spam_risk_too_many_posts':
    case 'spam_risk_user_banned_from_posting':
    case 'spam_risk':
      return 'spam_risk';
    default:
      if (status === 401) return 'reauth';
      if (status === 403) return 'forbidden';
      if (status === 429) return 'rate_limited';
      if (status >= 500) return 'unavailable';
      return 'bad_request';
  }
}

type Envelope = { data?: Record<string, unknown>; error?: { code?: string; message?: string } };

/**
 * POST JSON a un endpoint Content Posting (Bearer). TikTok avvolge tutto in { data, error } con
 * error.code === 'ok' al successo: ritorna `data`, oppure lancia un TikTokError classificato.
 */
export async function postApi(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  deadline?: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: signalFor(deadline),
    });
  } catch {
    throw new TikTokError({ status: 503, reason: 'network' });
  }
  const json = (await response.json().catch(() => null)) as Envelope | null;
  const code = typeof json?.error?.code === 'string' ? json.error.code : null;
  if (response.ok && code === 'ok') {
    return json?.data ?? {};
  }
  throw new TikTokError({
    status: response.status,
    reason: reasonForCode(response.status, code),
    tiktokCode: code,
  });
}
