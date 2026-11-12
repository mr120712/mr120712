// @polsia:user-owned — collegamento Solco ↔ Spotify: cookie OAuth cifrato, scambio del codice,
// rinnovo dei token (con rotazione) e salvataggio cifrato. I token restano sul server: nessuna
// risposta li contiene e nessun log li registra.
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  fetchWithRetry,
  parseRetryAfter,
  quotaExceededError,
  type SpotifyAuth,
  SpotifyError,
  type SpotifyFetchOptions,
} from '@/lib/spotify/client.server';
import {
  SPOTIFY_OAUTH_COOKIE,
  SPOTIFY_OAUTH_COOKIE_PATH,
  SPOTIFY_OAUTH_MAX_AGE_SECONDS,
  SPOTIFY_SCOPES,
  SPOTIFY_TOKEN_URL,
  type SpotifyConfig,
} from '@/lib/spotify/config.server';
import { openValue, sealValue } from '@/lib/spotify/token-crypto.server';

/** Refresh the access token when it expires within this window. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
const COOKIE_CONTEXT = 'spotify-oauth-cookie-v1';
/** Clock skew tolerated for a cookie that claims to come from the future. */
const COOKIE_FUTURE_SKEW_MS = 60_000;

const accessContext = (userId: string) => `spotify-access:${userId}`;
const refreshContext = (userId: string) => `spotify-refresh:${userId}`;

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
  if (now - t > SPOTIFY_OAUTH_MAX_AGE_SECONDS * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, cookie: { state: s, verifier: v, userId: u, issuedAt: t } };
}

/** Constant-time comparison of the returned `state` with the one in the cookie. */
export function statesMatch(received: string | null, expected: string): boolean {
  if (!received || received.length > 512) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function oauthCookieHeader(value: string, config: SpotifyConfig): string {
  return [
    `${SPOTIFY_OAUTH_COOKIE}=${value}`,
    `Path=${SPOTIFY_OAUTH_COOKIE_PATH}`,
    `Max-Age=${SPOTIFY_OAUTH_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

export function clearOAuthCookieHeader(config: SpotifyConfig): string {
  return [
    `${SPOTIFY_OAUTH_COOKIE}=`,
    `Path=${SPOTIFY_OAUTH_COOKIE_PATH}`,
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
    if (part.slice(0, index).trim() === SPOTIFY_OAUTH_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Token endpoint (POST https://accounts.spotify.com/api/token, form-encoded, PKCE: no secret).

export type SpotifyTokens = {
  accessToken: string;
  /** Absent on a refresh that did not rotate the refresh token: keep the stored one. */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
};

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4_096),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(4_096).optional(),
  scope: z.string().max(1_000).optional(),
});

const TokenErrorSchema = z.object({
  error: z.string().max(100),
  error_description: z.string().max(500).optional(),
});

async function tokenRequest(
  params: Record<string, string>,
  options: SpotifyFetchOptions,
): Promise<SpotifyTokens> {
  const response = await fetchWithRetry(
    SPOTIFY_TOKEN_URL,
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
    if (!parsed.success) throw new SpotifyError({ status: 502, reason: 'invalid_response' });
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
  const quota = quotaExceededError(response, body);
  if (quota) throw quota;
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw new SpotifyError({
      status: 429,
      reason: 'rate_limited',
      retryAfter: retryAfterMs === null ? 30 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });
  }
  // invalid_grant: expired, revoked or already-used code / refresh token → authorize again.
  if (code === 'invalid_grant') {
    throw new SpotifyError({ status: 401, reason: 'reauth', spotifyMessage: description });
  }
  if (response.status >= 500) {
    throw new SpotifyError({ status: response.status, reason: 'unavailable' });
  }
  throw new SpotifyError({
    status: response.status,
    reason: 'bad_request',
    spotifyMessage: description,
  });
}

/** Exchanges the authorization code (Authorization Code with PKCE). */
export function exchangeCode(
  config: SpotifyConfig,
  code: string,
  verifier: string,
  options: SpotifyFetchOptions = {},
): Promise<SpotifyTokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    },
    options,
  );
}

export function refreshAccessToken(
  config: SpotifyConfig,
  refreshToken: string,
  options: SpotifyFetchOptions = {},
): Promise<SpotifyTokens> {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId },
    options,
  );
}

/** True when Spotify granted every scope Solco asked for. */
export function hasRequiredScopes(scope: string | null): boolean {
  if (scope === null) return true; // Spotify omits `scope` only when nothing changed.
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return SPOTIFY_SCOPES.every((required) => granted.has(required));
}

// ---------------------------------------------------------------------------------------------
// Stored connection (one row per Solco user, tokens encrypted).

export async function saveConnection(userId: string, tokens: SpotifyTokens): Promise<void> {
  if (!tokens.refreshToken) throw new SpotifyError({ status: 502, reason: 'invalid_response' });
  const data = {
    accessToken: await sealValue(tokens.accessToken, accessContext(userId)),
    refreshToken: await sealValue(tokens.refreshToken, refreshContext(userId)),
    expiresAt: tokens.expiresAt,
    scope: tokens.scope ?? SPOTIFY_SCOPES.join(' '),
  };
  await prisma.spotifyConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

/**
 * 'outdated': connected with a grant that lacks a scope Solco now asks for (connections made
 * before playlist-read-collaborative was added). A refresh keeps the original grant and Spotify
 * re-sends its old `scope`, so only a new consent adds the scope: the listener must reconnect.
 */
export type ConnectionState = 'none' | 'connected' | 'outdated';

export async function connectionState(userId: string): Promise<ConnectionState> {
  const row = await prisma.spotifyConnection.findUnique({
    where: { userId },
    select: { scope: true },
  });
  if (!row) return 'none';
  return hasRequiredScopes(row.scope) ? 'connected' : 'outdated';
}

/** Deletes the person's Spotify tokens (disconnect, invalid refresh token, account deletion). */
export async function deleteConnection(userId: string): Promise<void> {
  await prisma.spotifyConnection.deleteMany({ where: { userId } });
}

const reauth = () => new SpotifyError({ status: 401, reason: 'reauth' });

/**
 * Credentials for the person's Spotify calls, refreshed when they expire within 60 s; null when
 * Spotify is not connected, SpotifyError 'scope_outdated' when the stored grant lacks a scope. `refresh` is shared by concurrent calls (a single token request) and
 * handles rotation; an invalid refresh token deletes the row and throws SpotifyError 'reauth'.
 */
export async function spotifyAuthFor(
  userId: string,
  config: SpotifyConfig,
  options: SpotifyFetchOptions = {},
): Promise<SpotifyAuth | null> {
  const row = await prisma.spotifyConnection.findUnique({ where: { userId } });
  if (!row) return null;
  // Older grant without a scope Solco now needs: keep the row (the listener may still just
  // disconnect) and ask for a new consent, which replaces tokens and scope.
  if (!hasRequiredScopes(row.scope)) {
    throw new SpotifyError({ status: 401, reason: 'scope_outdated' });
  }
  let storedRefresh = row.refreshToken;
  let refreshToken = await openValue(row.refreshToken, refreshContext(userId));
  if (!refreshToken) {
    // Undecryptable (key changed or row tampered with): the person must connect again.
    await prisma.spotifyConnection.deleteMany({ where: { userId, refreshToken: storedRefresh } });
    throw reauth();
  }

  let pending: Promise<string> | null = null;
  const doRefresh = async (): Promise<string> => {
    let tokens: SpotifyTokens;
    try {
      tokens = await refreshAccessToken(config, refreshToken as string, options);
    } catch (error) {
      if (error instanceof SpotifyError && error.reason === 'reauth') {
        // A parallel request may have rotated the refresh token already: use its result.
        const latest = await prisma.spotifyConnection.findUnique({ where: { userId } });
        if (
          latest &&
          latest.refreshToken !== storedRefresh &&
          latest.expiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS
        ) {
          const access = await openValue(latest.accessToken, accessContext(userId));
          if (access) return access;
        }
        // Only delete the row that still holds the token Spotify rejected.
        await prisma.spotifyConnection.deleteMany({
          where: { userId, refreshToken: storedRefresh },
        });
      }
      throw error;
    }
    const nextRefresh = tokens.refreshToken ?? (refreshToken as string);
    const sealedRefresh = tokens.refreshToken
      ? await sealValue(tokens.refreshToken, refreshContext(userId))
      : storedRefresh;
    const updated = await prisma.spotifyConnection.updateMany({
      where: { userId },
      data: {
        accessToken: await sealValue(tokens.accessToken, accessContext(userId)),
        refreshToken: sealedRefresh,
        expiresAt: tokens.expiresAt,
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });
    // Disconnected meanwhile: do not keep using Spotify on the person's behalf.
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
