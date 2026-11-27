// @polsia:user-owned — configurazione del collegamento account YouTube (OAuth Google, Authorization
// Code + PKCE). A differenza di Spotify, Google è un client CONFIDENZIALE: oltre a GOOGLE_CLIENT_ID
// serve GOOGLE_CLIENT_SECRET. Senza configurazione valida la funzione è spenta: la UI non compare e
// le route rispondono 404 youtube_not_configured.
import 'server-only';
import { redirectOrigin } from '@/lib/spotify/config.server';
import { hasTokenKey } from '@/lib/youtube-account/token-crypto.server';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
/**
 * Minimo scope necessario, sola lettura: elencare le playlist dell'utente (anche private) e i loro
 * elementi. `youtube.readonly` copre playlists.list?mine=true e playlistItems.list.
 */
export const YOUTUBE_ACCOUNT_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'] as const;
/** Pagina Solco che ospita "Connetti YouTube"; ogni redirect torna qui. */
export const YOUTUBE_IMPORT_PAGE = '/library';
export const YOUTUBE_CALLBACK_PATH = '/api/music/youtube/callback';
export const YOUTUBE_OAUTH_COOKIE = 'solco_youtube_oauth';
export const YOUTUBE_OAUTH_COOKIE_PATH = '/api/music/youtube';
export const YOUTUBE_OAUTH_MAX_AGE_SECONDS = 600;

export type YouTubeAccountConfig = {
  clientId: string;
  clientSecret: string;
  /** Public origin of Solco (https, or http://127.0.0.1 for local development). */
  appOrigin: string;
  redirectUri: string;
  secureCookies: boolean;
};

export function youtubeAccountConfig(): YouTubeAccountConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  // Google web client IDs look like "<digits>-<hash>.apps.googleusercontent.com".
  if (!/\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret.length < 8) return null;
  const appOrigin = redirectOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (!appOrigin || !hasTokenKey()) return null;
  return {
    clientId,
    clientSecret,
    appOrigin,
    redirectUri: `${appOrigin}${YOUTUBE_CALLBACK_PATH}`,
    secureCookies: appOrigin.startsWith('https:'),
  };
}

export const youtubePrivateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
} as const;

/** `{ error, message }` JSON with the private no-store headers. */
export function youtubeJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...youtubePrivateHeaders, ...headers } });
}

export function notConfiguredResponse(): Response {
  return youtubeJson(
    {
      error: 'youtube_not_configured',
      message: 'Il collegamento con YouTube non è disponibile al momento.',
    },
    404,
  );
}

/** Copies a Response adding the private no-store headers (for shared helpers' responses). */
export function withPrivateHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(youtubePrivateHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
