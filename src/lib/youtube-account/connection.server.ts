// @polsia:user-owned — collegamento Solco ↔ account YouTube/Google: cookie OAuth cifrato, scambio
// del codice (client confidenziale: con client_secret), rinnovo dei token e salvataggio cifrato. I
// token restano sul server: nessuna risposta li contiene e nessun log li registra. Speculare a
// src/lib/spotify/connection.server.ts; Google non ruota il refresh token, quindi al refresh si
// mantiene quello salvato.
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { parseRetryAfter } from '@/lib/spotify/client.server';
import {
  fetchWithRetry,
  type YouTubeAuth,
  YouTubeError,
  type YouTubeFetchOptions,
} from '@/lib/youtube-account/client.server';
import {
  GOOGLE_TOKEN_URL,
  YOUTUBE_ACCOUNT_SCOPES,
  YOUTUBE_OAUTH_COOKIE,
  YOUTUBE_OAUTH_COOKIE_PATH,
  YOUTUBE_OAUTH_MAX_AGE_SECONDS,
  type YouTubeAccountConfig,
} from '@/lib/youtube-account/config.server';
import { openValue, sealValue } from '@/lib/youtube-account/token-crypto.server';

/** Refresh the access token when it expires within this window. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
const COOKIE_CONTEXT = 'youtube-oauth-cookie-v1';
const COOKIE_FUTURE_SKEW_MS = 60_000;

const accessContext = (userId: string) => `youtube-access:${userId}`;
const refreshContext = (userId: string) => `youtube-refresh:${userId}`;

// ---------------------------------------------------------------------------------------------
// OAuth cookie: { state, code_verifier, userId, issuedAt }, encrypted, HttpOnly, 10 minutes.

export type OAuthCookie = { state: string; verifier: string; userId: string; issuedAt: number };

const OAuthCookieSchema = z
  .object({
    s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    v: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    u: z.string().min(1).max(200),
    t: z.number().int().nonnegative(),
  })
  .strict();

export function sealOAuthCookie(cookie: OAuthCookie): Promise<string> {
  return sealValue(
    JSON.stringify({ s: cookie.state, v: cookie.verifier, u: cookie.userId, t: cookie.issuedAt }),
    COOKIE_CONTEXT,
  );
}

export type OpenedOAuthCookie =
  | { ok: true; cookie: OAuthCookie }
  | { ok: false; reason: 'invalid' | 'expired' };

export async function openOAuthCookie(
  sealed: string,
  now = Date.now(),
): Promise<OpenedOAuthCookie> {
  const plaintext = await openValue(sealed, COOKIE_CONTEXT);
  if (!plaintext) return { ok: false, reason: 'invalid' };
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const parsed = OAuthCookieSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const { s, v, u, t } = parsed.data;
  if (t > now + COOKIE_FUTURE_SKEW_MS) return { ok: false, reason: 'invalid' };
  if (now - t > YOUTUBE_OAUTH_MAX_AGE_SECONDS * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, cookie: { state: s, verifier: v, userId: u, issuedAt: t } };
}

/** Constant-time comparison of the returned `state` with the one in the cookie. */
export function statesMatch(received: string | null, expected: string): boolean {
  if (!received || received.length > 512) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function oauthCookieHeader(value: string, config: YouTubeAccountConfig): string {
  return [
    `${YOUTUBE_OAUTH_COOKIE}=${value}`,
    `Path=${YOUTUBE_OAUTH_COOKIE_PATH}`,
    `Max-Age=${YOUTUBE_OAUTH_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

export function clearOAuthCookieHeader(config: YouTubeAccountConfig): string {
  return [
    `${YOUTUBE_OAUTH_COOKIE}=`,
    `Path=${YOUTUBE_OAUTH_COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

/** Value of the OAuth cookie in the request, or null. */
export function readOAuthCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === YOUTUBE_OAUTH_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Token endpoint (POST https://oauth2.googleapis.com/token, form-encoded, confidential client).

export type YouTubeTokens = {
  accessToken: string;
  /** Absent on a refresh (Google keeps the same refresh token): keep the stored one. */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
};

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4_096),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(4_096).optional(),
  scope: z.string().max(2_000).optional(),
});

const TokenErrorSchema = z.object({
  error: z.string().max(100),
  error_description: z.string().max(500).optional(),
});

async function tokenRequest(
  params: Record<string, string>,
  options: YouTubeFetchOptions,
): Promise<YouTubeTokens> {
  const response = await fetchWithRetry(
    GOOGLE_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    },
    options,
  );
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new YouTubeError({ status: 502, reason: 'invalid_response' });
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
      scope: parsed.data.scope ?? null,
    };
  }
  const error = TokenErrorSchema.safeParse(body);
  const code = error.success ? error.data.error : null;
  const description = error.success ? (error.data.error_description ?? code) : null;
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw new YouTubeError({
      status: 429,
      reason: 'rate_limited',
      retryAfter: retryAfterMs === null ? 30 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });
  }
  // invalid_grant: expired/revoked/already-used code or refresh token → authorize again.
  if (code === 'invalid_grant') {
    throw new YouTubeError({ status: 401, reason: 'reauth', providerMessage: description });
  }
  if (response.status >= 500) {
    throw new YouTubeError({ status: response.status, reason: 'unavailable' });
  }
  throw new YouTubeError({
    status: response.status,
    reason: 'bad_request',
    providerMessage: description,
  });
}

/** Exchanges the authorization code (Authorization Code + PKCE, confidential client). */
export function exchangeCode(
  config: YouTubeAccountConfig,
  code: string,
  verifier: string,
  options: YouTubeFetchOptions = {},
): Promise<YouTubeTokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: verifier,
    },
    options,
  );
}

export function refreshAccessToken(
  config: YouTubeAccountConfig,
  refreshToken: string,
  options: YouTubeFetchOptions = {},
): Promise<YouTubeTokens> {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    options,
  );
}

/** True when Google granted every scope Solco asked for (Google omits `scope` only on refresh). */
export function hasRequiredScopes(scope: string | null): boolean {
  if (scope === null) return true;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return YOUTUBE_ACCOUNT_SCOPES.every((required) => granted.has(required));
}

// ---------------------------------------------------------------------------------------------
// Stored connection (one row per Solco user, tokens encrypted).

export async function saveConnection(userId: string, tokens: YouTubeTokens): Promise<void> {
  if (!tokens.refreshToken) throw new YouTubeError({ status: 502, reason: 'invalid_response' });
  const data = {
    accessToken: await sealValue(tokens.accessToken, accessContext(userId)),
    refreshToken: await sealValue(tokens.refreshToken, refreshContext(userId)),
    expiresAt: tokens.expiresAt,
    scope: tokens.scope ?? YOUTUBE_ACCOUNT_SCOPES.join(' '),
  };
  await prisma.youTubeConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export type ConnectionState = 'none' | 'connected';

export async function connectionState(userId: string): Promise<ConnectionState> {
  const row = await prisma.youTubeConnection.findUnique({
    where: { userId },
    select: { userId: true },
  });
  return row ? 'connected' : 'none';
}

/** Deletes the person's YouTube tokens (disconnect, invalid refresh token, account deletion). */
export async function deleteConnection(userId: string): Promise<void> {
  await prisma.youTubeConnection.deleteMany({ where: { userId } });
}

const reauth = () => new YouTubeError({ status: 401, reason: 'reauth' });

/**
 * Credentials for the person's YouTube calls, refreshed when they expire within 60 s; null when
 * YouTube is not connected. `refresh` is shared by concurrent calls (a single token request); an
 * invalid refresh token deletes the row and throws YouTubeError 'reauth'.
 */
export async function youtubeAuthFor(
  userId: string,
  config: YouTubeAccountConfig,
  options: YouTubeFetchOptions = {},
): Promise<YouTubeAuth | null> {
  const row = await prisma.youTubeConnection.findUnique({ where: { userId } });
  if (!row) return null;
  let storedRefresh = row.refreshToken;
  let refreshToken = await openValue(row.refreshToken, refreshContext(userId));
  if (!refreshToken) {
    // Undecryptable (key changed or row tampered with): the person must connect again.
    await prisma.youTubeConnection.deleteMany({ where: { userId, refreshToken: storedRefresh } });
    throw reauth();
  }

  let pending: Promise<string> | null = null;
  const doRefresh = async (): Promise<string> => {
    let tokens: YouTubeTokens;
    try {
      tokens = await refreshAccessToken(config, refreshToken as string, options);
    } catch (error) {
      if (error instanceof YouTubeError && error.reason === 'reauth') {
        // A parallel request may have refreshed already: use its stored access token.
        const latest = await prisma.youTubeConnection.findUnique({ where: { userId } });
        if (
          latest &&
          latest.expiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS &&
          latest.refreshToken !== storedRefresh
        ) {
          const access = await openValue(latest.accessToken, accessContext(userId));
          if (access) return access;
        }
        await prisma.youTubeConnection.deleteMany({
          where: { userId, refreshToken: storedRefresh },
        });
      }
      throw error;
    }
    // Google normally returns no new refresh token: keep the stored one.
    const nextRefresh = tokens.refreshToken ?? (refreshToken as string);
    const sealedRefresh = tokens.refreshToken
      ? await sealValue(tokens.refreshToken, refreshContext(userId))
      : storedRefresh;
    const updated = await prisma.youTubeConnection.updateMany({
      where: { userId },
      data: {
        accessToken: await sealValue(tokens.accessToken, accessContext(userId)),
        refreshToken: sealedRefresh,
        expiresAt: tokens.expiresAt,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });
    if (updated.count === 0) throw reauth();
    refreshToken = nextRefresh;
    storedRefresh = sealedRefresh;
    return tokens.accessToken;
  };
  const refresh = () => {
    pending ??= doRefresh().finally(() => {
      pending = null;
    });
    return pending;
  };

  const stored = await openValue(row.accessToken, accessContext(userId));
  const fresh = stored && row.expiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS;
  const accessToken = fresh ? stored : await refresh();
  return { accessToken, refresh };
}
