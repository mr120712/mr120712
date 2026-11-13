// @polsia:user-owned — collegamento Solco ↔ TikTok (Login Kit v2): cookie OAuth cifrato, scambio
// del codice (PKCE + client_secret), rinnovo dei token con rotazione e salvataggio cifrato. I token
// restano sul server: nessuna risposta li contiene e nessun log li registra.
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { postForm, TikTokError } from '@/lib/tiktok/client.server';
import {
  TIKTOK_OAUTH_COOKIE,
  TIKTOK_OAUTH_COOKIE_PATH,
  TIKTOK_OAUTH_MAX_AGE_SECONDS,
  TIKTOK_SCOPES,
  TIKTOK_TOKEN_URL,
  type TikTokConfig,
} from '@/lib/tiktok/config.server';
import { openValue, sealValue } from '@/lib/tiktok/token-crypto.server';

/** Rinnova l'access token quando scade entro questa finestra. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
const COOKIE_CONTEXT = 'tiktok-oauth-cookie-v1';
const COOKIE_FUTURE_SKEW_MS = 60_000;

const accessContext = (userId: string) => `tiktok-access:${userId}`;
const refreshContext = (userId: string) => `tiktok-refresh:${userId}`;

// ---------------------------------------------------------------------------------------------
// OAuth cookie: { state, verifier, userId, issuedAt }, encrypted, HttpOnly, 10 minutes.

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
  if (now - t > TIKTOK_OAUTH_MAX_AGE_SECONDS * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, cookie: { state: s, verifier: v, userId: u, issuedAt: t } };
}

/** Confronto in tempo costante dello `state` ricevuto con quello del cookie. */
export function statesMatch(received: string | null, expected: string): boolean {
  if (!received || received.length > 512) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function oauthCookieHeader(value: string, config: TikTokConfig): string {
  return [
    `${TIKTOK_OAUTH_COOKIE}=${value}`,
    `Path=${TIKTOK_OAUTH_COOKIE_PATH}`,
    `Max-Age=${TIKTOK_OAUTH_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

export function clearOAuthCookieHeader(config: TikTokConfig): string {
  return [
    `${TIKTOK_OAUTH_COOKIE}=`,
    `Path=${TIKTOK_OAUTH_COOKIE_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

export function readOAuthCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === TIKTOK_OAUTH_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Token endpoint (POST open.tiktokapis.com/v2/oauth/token/, form-encoded, client_key + secret).

export type TikTokTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  openId: string;
  scope: string;
};

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4_096),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(4_096),
  refresh_expires_in: z.number().int().positive().max(31_536_000),
  open_id: z.string().min(1).max(256),
  scope: z.string().max(1_000).optional().default(''),
  token_type: z.string().optional(),
});

const TokenErrorSchema = z.object({
  error: z.string().max(100),
  error_description: z.string().max(500).optional(),
});

function toTokens(parsed: z.infer<typeof TokenResponseSchema>): TikTokTokens {
  const now = Date.now();
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessExpiresAt: new Date(now + parsed.expires_in * 1000),
    refreshExpiresAt: new Date(now + parsed.refresh_expires_in * 1000),
    openId: parsed.open_id,
    scope: parsed.scope ?? '',
  };
}

async function tokenRequest(
  params: Record<string, string>,
  deadline?: number,
): Promise<TikTokTokens> {
  const { ok, status, body } = await postForm(TIKTOK_TOKEN_URL, params, deadline);
  if (ok) {
    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new TikTokError({ status: 502, reason: 'invalid_response' });
    return toTokens(parsed.data);
  }
  const err = TokenErrorSchema.safeParse(body);
  const code = err.success ? err.data.error : null;
  if (status === 429)
    throw new TikTokError({ status: 429, reason: 'rate_limited', tiktokCode: code });
  // invalid_grant: code/refresh token scaduto, revocato o già usato → ricollegare.
  if (code === 'invalid_grant' || status === 401) {
    throw new TikTokError({ status: 401, reason: 'reauth', tiktokCode: code });
  }
  if (status >= 500) throw new TikTokError({ status, reason: 'unavailable', tiktokCode: code });
  throw new TikTokError({ status, reason: 'bad_request', tiktokCode: code });
}

export function exchangeCode(
  config: TikTokConfig,
  code: string,
  verifier: string,
  deadline?: number,
): Promise<TikTokTokens> {
  return tokenRequest(
    {
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    },
    deadline,
  );
}

export function refreshTokens(
  config: TikTokConfig,
  refreshToken: string,
  deadline?: number,
): Promise<TikTokTokens> {
  return tokenRequest(
    {
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    deadline,
  );
}

/** True quando TikTok ha concesso tutti gli scope che Solco chiede. */
export function hasRequiredScopes(scope: string): boolean {
  const granted = new Set(scope.split(/[\s,]+/).filter(Boolean));
  return TIKTOK_SCOPES.every((required) => granted.has(required));
}

// ---------------------------------------------------------------------------------------------
// Stored connection (one row per connecting admin, tokens encrypted).

export async function saveConnection(userId: string, tokens: TikTokTokens): Promise<void> {
  const data = {
    openId: tokens.openId,
    accessToken: await sealValue(tokens.accessToken, accessContext(userId)),
    refreshToken: await sealValue(tokens.refreshToken, refreshContext(userId)),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    scope: tokens.scope || TIKTOK_SCOPES.join(','),
  };
  await prisma.tikTokConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export type ConnectionState = 'none' | 'connected' | 'outdated' | 'expired';

export type ConnectionSummary = {
  state: ConnectionState;
  openId: string | null;
  scope: string | null;
  updatedAt: string | null;
};

export async function connectionSummary(
  userId: string,
  now = new Date(),
): Promise<ConnectionSummary> {
  const row = await prisma.tikTokConnection.findUnique({
    where: { userId },
    select: { openId: true, scope: true, refreshExpiresAt: true, updatedAt: true },
  });
  if (!row) return { state: 'none', openId: null, scope: null, updatedAt: null };
  const base = { openId: row.openId, scope: row.scope, updatedAt: row.updatedAt.toISOString() };
  // Il refresh token di TikTok scade (365 giorni): oltre, serve ricollegare.
  if (row.refreshExpiresAt.getTime() <= now.getTime()) return { state: 'expired', ...base };
  if (!hasRequiredScopes(row.scope)) return { state: 'outdated', ...base };
  return { state: 'connected', ...base };
}

export async function deleteConnection(userId: string): Promise<void> {
  await prisma.tikTokConnection.deleteMany({ where: { userId } });
}

const reauth = (code: string | null = null) =>
  new TikTokError({ status: 401, reason: 'reauth', tiktokCode: code });

/**
 * Access token valido per le chiamate di `userId`, rinnovato se scade entro 60 s. Lancia TikTokError
 * 'reauth' quando non c'è collegamento, il refresh token è scaduto/non decifrabile, o TikTok lo
 * rifiuta (in quel caso la riga viene eliminata: va rifatto il collegamento).
 */
export async function tiktokAccessTokenFor(
  userId: string,
  config: TikTokConfig,
  deadline?: number,
): Promise<string> {
  const row = await prisma.tikTokConnection.findUnique({ where: { userId } });
  if (!row) throw reauth();
  if (!hasRequiredScopes(row.scope))
    throw new TikTokError({ status: 401, reason: 'scope_not_authorized' });

  const stored = await openValue(row.accessToken, accessContext(userId));
  if (stored && row.accessExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return stored;
  }

  const refreshToken = await openValue(row.refreshToken, refreshContext(userId));
  if (!refreshToken || row.refreshExpiresAt.getTime() <= Date.now()) {
    await prisma.tikTokConnection.deleteMany({ where: { userId } });
    throw reauth();
  }

  let tokens: TikTokTokens;
  try {
    tokens = await refreshTokens(config, refreshToken, deadline);
  } catch (error) {
    if (error instanceof TikTokError && error.reason === 'reauth') {
      await prisma.tikTokConnection.deleteMany({ where: { userId } });
    }
    throw error;
  }
  const updated = await prisma.tikTokConnection.updateMany({
    where: { userId },
    data: {
      openId: tokens.openId,
      accessToken: await sealValue(tokens.accessToken, accessContext(userId)),
      refreshToken: await sealValue(tokens.refreshToken, refreshContext(userId)),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    },
  });
  if (updated.count === 0) throw reauth();
  return tokens.accessToken;
}
