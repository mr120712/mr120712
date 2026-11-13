// @polsia:user-owned — configurazione del collegamento a TikTok (Login Kit v2, Authorization Code
// con PKCE + client_secret). Serve TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET (segreto server-side su
// Vercel) e una chiave per cifrare i token. Senza configurazione valida la funzione è spenta: la UI
// non compare e le route rispondono 404 tiktok_not_configured. Non pubblica nulla da sola.
import 'server-only';
import { hasTokenKey } from '@/lib/tiktok/token-crypto.server';

export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

/**
 * Scope minimi: identità di base del creator e pubblicazione diretta del video. TikTok li passa
 * come stringa separata da virgole e devono essere assegnati all'app su TikTok for Developers.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish'] as const;

/** Pagina admin che ospita "Collega TikTok"; ogni redirect torna qui. */
export const TIKTOK_ADMIN_PAGE = '/admin/tiktok';
export const TIKTOK_CALLBACK_PATH = '/api/admin/tiktok/connect/callback';
export const TIKTOK_OAUTH_COOKIE = 'solco_tiktok_oauth';
export const TIKTOK_OAUTH_COOKIE_PATH = '/api/admin/tiktok';
export const TIKTOK_OAUTH_MAX_AGE_SECONDS = 600;

export type TikTokConfig = {
  clientKey: string;
  clientSecret: string;
  /** Public origin of Solco (https, or http://127.0.0.1 for local development). */
  appOrigin: string;
  redirectUri: string;
  secureCookies: boolean;
};

/**
 * Origin ammesso per il redirect URI: HTTPS, oppure il loopback 127.0.0.1 su HTTP in sviluppo.
 * Mai `localhost`, wildcard o credenziali.
 */
export function redirectOrigin(appUrl: string | undefined): string | null {
  if (!appUrl || appUrl.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(appUrl.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:' && url.hostname !== 'localhost') return url.origin;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url.origin;
  return null;
}

export function tiktokConfig(): TikTokConfig | null {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim() ?? '';
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim() ?? '';
  // Le chiavi TikTok sono alfanumeriche; accetta un id corto e un secret di lunghezza plausibile.
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(clientKey)) return null;
  if (clientSecret.length < 16 || clientSecret.length > 256) return null;
  const appOrigin = redirectOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (!appOrigin || !hasTokenKey()) return null;
  return {
    clientKey,
    clientSecret,
    appOrigin,
    redirectUri: `${appOrigin}${TIKTOK_CALLBACK_PATH}`,
    secureCookies: appOrigin.startsWith('https:'),
  };
}

export const tiktokPrivateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
} as const;

/** `{ error, message }` JSON con gli header privati no-store. */
export function tiktokJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...tiktokPrivateHeaders, ...headers } });
}

export function notConfiguredResponse(): Response {
  return tiktokJson(
    {
      error: 'tiktok_not_configured',
      message: 'Il collegamento a TikTok non è configurato.',
    },
    404,
  );
}
