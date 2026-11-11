// @polsia:user-owned — ritorno da Spotify dopo "Accedi con Spotify". Verifica il cookie OAuth
// (cifrato, 10 minuti, state confrontato in tempo costante, stesso utente Solco), scambia il
// codice con il code_verifier (PKCE) e salva i token cifrati. Rimanda sempre alla Libreria con
// ?spotify=connected oppure ?spotify=error&reason=<motivo fisso>: nessun input riflesso.
import 'server-only';
import type { SpotifyCallbackReason } from '@/lib/contracts/spotify';
import { getSessionUser, type SessionUser } from '@/lib/require-auth';
import { SpotifyError, spotifyFetch } from '@/lib/spotify/client.server';
import {
  notConfiguredResponse,
  SPOTIFY_IMPORT_PAGE,
  type SpotifyConfig,
  spotifyConfig,
  spotifyPrivateHeaders,
} from '@/lib/spotify/config.server';
import {
  clearOAuthCookieHeader,
  exchangeCode,
  hasRequiredScopes,
  openOAuthCookie,
  readOAuthCookie,
  saveConnection,
  statesMatch,
} from '@/lib/spotify/connection.server';

export const dynamic = 'force-dynamic';

/** Whole callback (token exchange + allowlist check) stays well within the function limit. */
const CALLBACK_BUDGET_MS = 25_000;

function back(config: SpotifyConfig, query: string): Response {
  const headers = new Headers({
    ...spotifyPrivateHeaders,
    Location: `${config.appOrigin}${SPOTIFY_IMPORT_PAGE}?${query}`,
    // The callback URL carries the authorization code: never leak it to the next page.
    'Referrer-Policy': 'no-referrer',
  });
  headers.append('Set-Cookie', clearOAuthCookieHeader(config));
  return new Response(null, { status: 302, headers });
}

function fail(config: SpotifyConfig, reason: SpotifyCallbackReason): Response {
  return back(config, `spotify=error&reason=${reason}`);
}

async function sessionUser(): Promise<SessionUser | null> {
  try {
    return await getSessionUser();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const config = spotifyConfig();
  if (!config) return notConfiguredResponse();

  const sealed = readOAuthCookie(request);
  if (!sealed) return fail(config, 'expired');
  const opened = await openOAuthCookie(sealed);
  if (!opened.ok) return fail(config, opened.reason === 'expired' ? 'expired' : 'invalid_state');

  const params = new URL(request.url).searchParams;
  if (!statesMatch(params.get('state'), opened.cookie.state)) return fail(config, 'invalid_state');

  const user = await sessionUser();
  if (!user || user.id !== opened.cookie.userId) return fail(config, 'session');

  const error = params.get('error');
  if (error) return fail(config, error === 'access_denied' ? 'denied' : 'failed');
  const code = params.get('code');
  if (!code || code.length > 2_048) return fail(config, 'failed');

  const deadline = Date.now() + CALLBACK_BUDGET_MS;
  try {
    const tokens = await exchangeCode(config, code, opened.cookie.verifier, { deadline });
    if (!hasRequiredScopes(tokens.scope)) return fail(config, 'failed');
    // Development-mode apps answer 403 to people missing from the allowlist: say so right away
    // instead of storing tokens that cannot read anything.
    try {
      await spotifyFetch('/me/tracks?limit=1', { accessToken: tokens.accessToken }, { deadline });
    } catch (probeError) {
      if (probeError instanceof SpotifyError && probeError.reason === 'not_allowlisted') {
        return fail(config, 'not_allowlisted');
      }
      // Anything else (a busy Spotify) is reported later by the playlist list.
    }
    await saveConnection(user.id, tokens);
  } catch (exchangeError) {
    if (
      exchangeError instanceof SpotifyError &&
      (exchangeError.reason === 'rate_limited' || exchangeError.reason === 'quota_exceeded')
    ) {
      return fail(config, 'rate_limited');
    }
    if (!(exchangeError instanceof SpotifyError)) {
      // biome-ignore lint/suspicious/noConsole: server log of the error name only (no tokens).
      console.error(
        '[spotify] callback failed',
        exchangeError instanceof Error ? exchangeError.name : 'unknown',
      );
    }
    return fail(config, 'failed');
  }
  return back(config, 'spotify=connected');
}
