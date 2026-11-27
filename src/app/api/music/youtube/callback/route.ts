// @polsia:user-owned — ritorno da Google dopo "Connetti YouTube". Verifica il cookie OAuth (cifrato,
// 10 minuti, state in tempo costante, stesso utente Solco), scambia il codice con il code_verifier
// (PKCE, con client_secret) e salva i token cifrati. Rimanda sempre alla Libreria con
// ?youtube=connected oppure ?youtube=error&reason=<motivo fisso>: nessun input riflesso.
import 'server-only';
import type { YouTubeCallbackReason } from '@/lib/contracts/youtube-account';
import { getSessionUser, type SessionUser } from '@/lib/require-auth';
import { YouTubeError } from '@/lib/youtube-account/client.server';
import {
  notConfiguredResponse,
  YOUTUBE_IMPORT_PAGE,
  type YouTubeAccountConfig,
  youtubeAccountConfig,
  youtubePrivateHeaders,
} from '@/lib/youtube-account/config.server';
import {
  clearOAuthCookieHeader,
  exchangeCode,
  hasRequiredScopes,
  openOAuthCookie,
  readOAuthCookie,
  saveConnection,
  statesMatch,
} from '@/lib/youtube-account/connection.server';

export const dynamic = 'force-dynamic';

const CALLBACK_BUDGET_MS = 25_000;

function back(config: YouTubeAccountConfig, query: string): Response {
  const headers = new Headers({
    ...youtubePrivateHeaders,
    Location: `${config.appOrigin}${YOUTUBE_IMPORT_PAGE}?${query}`,
    // The callback URL carries the authorization code: never leak it to the next page.
    'Referrer-Policy': 'no-referrer',
  });
  headers.append('Set-Cookie', clearOAuthCookieHeader(config));
  return new Response(null, { status: 302, headers });
}

function fail(config: YouTubeAccountConfig, reason: YouTubeCallbackReason): Response {
  return back(config, `youtube=error&reason=${reason}`);
}

async function sessionUser(): Promise<SessionUser | null> {
  try {
    return await getSessionUser();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const config = youtubeAccountConfig();
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
    if (!hasRequiredScopes(tokens.scope)) return fail(config, 'denied');
    await saveConnection(user.id, tokens);
  } catch (exchangeError) {
    if (
      exchangeError instanceof YouTubeError &&
      (exchangeError.reason === 'rate_limited' || exchangeError.reason === 'quota_exceeded')
    ) {
      return fail(config, 'rate_limited');
    }
    if (!(exchangeError instanceof YouTubeError)) {
      // biome-ignore lint/suspicious/noConsole: server log of the error name only (no tokens).
      console.error(
        '[youtube] callback failed',
        exchangeError instanceof Error ? exchangeError.name : 'unknown',
      );
    }
    return fail(config, 'failed');
  }
  return back(config, 'youtube=connected');
}
