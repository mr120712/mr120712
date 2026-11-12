// @polsia:user-owned — configurazione dell'importazione da Spotify (Authorization Code con PKCE).
// Client pubblico: serve solo SPOTIFY_CLIENT_ID, nessun client secret. Senza configurazione valida
// la funzione è spenta: la UI non compare e le route rispondono 404 spotify_not_configured.
import 'server-only';
import { hasTokenKey } from '@/lib/spotify/token-crypto.server';

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
/**
 * Minimum scopes, all read-only (docs: web-api/concepts/scopes and web-api/concepts/playlists):
 * - GET /me/playlists returns private non-collaborative playlists only with playlist-read-private
 *   and collaborative playlists (owned or followed) only with playlist-read-collaborative. The
 *   endpoint's reference page and OpenAPI `security` block list only playlist-read-private.
 * - GET /playlists/{id}/items needs playlist-read-private.
 * - GET /me/tracks needs user-library-read.
 */
export const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
] as const;
/** Solco page that hosts "Importa da Spotify"; every redirect lands here. */
export const SPOTIFY_IMPORT_PAGE = '/library';
export const SPOTIFY_CALLBACK_PATH = '/api/spotify/callback';
export const SPOTIFY_OAUTH_COOKIE = 'solco_spotify_oauth';
export const SPOTIFY_OAUTH_COOKIE_PATH = '/api/spotify';
export const SPOTIFY_OAUTH_MAX_AGE_SECONDS = 600;

export type SpotifyConfig = {
  clientId: string;
  /** Public origin of Solco (https, or http://127.0.0.1 for local development). */
  appOrigin: string;
  redirectUri: string;
  secureCookies: boolean;
};

/**
 * Origin allowed for the redirect URI: HTTPS, or the loopback literal 127.0.0.1 over HTTP for
 * local development. Never `localhost`, wildcards or credentials (Spotify redirect URI rules).
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

export function spotifyConfig(): SpotifyConfig | null {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim() ?? '';
  // Spotify client IDs are 32 hexadecimal characters; accept any short alphanumeric id.
  if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) return null;
  const appOrigin = redirectOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (!appOrigin || !hasTokenKey()) return null;
  return {
    clientId,
    appOrigin,
    redirectUri: `${appOrigin}${SPOTIFY_CALLBACK_PATH}`,
    secureCookies: appOrigin.startsWith('https:'),
  };
}

export const spotifyPrivateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
} as const;

/** `{ error, message }` JSON with the private no-store headers. */
export function spotifyJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...spotifyPrivateHeaders, ...headers } });
}

export function notConfiguredResponse(): Response {
  return spotifyJson(
    {
      error: 'spotify_not_configured',
      message: 'L’importazione da Spotify non è disponibile al momento.',
    },
    404,
  );
}

/** Copies a Response adding the private no-store headers (for shared helpers' responses). */
export function withPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(spotifyPrivateHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
