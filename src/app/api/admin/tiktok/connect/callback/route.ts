// @polsia:user-owned — ritorno da TikTok dopo "Collega TikTok". Verifica il cookie OAuth (cifrato,
// 10 minuti, state in tempo costante, stesso amministratore), scambia il codice con il
// code_verifier (PKCE + client_secret) e salva i token cifrati. Rimanda sempre a /admin/tiktok con
// ?tiktok=connected oppure ?tiktok=error&reason=<motivo fisso>: nessun input riflesso.
import 'server-only';
import { auth } from '@/lib/auth';
import { TikTokError } from '@/lib/tiktok/client.server';
import {
  notConfiguredResponse,
  TIKTOK_ADMIN_PAGE,
  type TikTokConfig,
  tiktokConfig,
  tiktokPrivateHeaders,
} from '@/lib/tiktok/config.server';
import {
  clearOAuthCookieHeader,
  exchangeCode,
  hasRequiredScopes,
  openOAuthCookie,
  readOAuthCookie,
  saveConnection,
  statesMatch,
} from '@/lib/tiktok/connection.server';

export const dynamic = 'force-dynamic';

const CALLBACK_BUDGET_MS = 25_000;

type Reason =
  | 'expired'
  | 'invalid_state'
  | 'session'
  | 'denied'
  | 'failed'
  | 'rate_limited'
  | 'scope';

function back(config: TikTokConfig, query: string): Response {
  const headers = new Headers({
    ...tiktokPrivateHeaders,
    Location: `${config.appOrigin}${TIKTOK_ADMIN_PAGE}?${query}`,
    // L'URL di callback porta il codice: non farlo trapelare alla pagina successiva.
    'Referrer-Policy': 'no-referrer',
  });
  headers.append('Set-Cookie', clearOAuthCookieHeader(config));
  return new Response(null, { status: 302, headers });
}

function fail(config: TikTokConfig, reason: Reason): Response {
  return back(config, `tiktok=error&reason=${reason}`);
}

async function adminId(request: Request): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (session?.user?.role === 'admin' && session.user.emailVerified === true) {
      return session.user.id;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function GET(request: Request) {
  const config = tiktokConfig();
  if (!config) return notConfiguredResponse();

  const sealed = readOAuthCookie(request);
  if (!sealed) return fail(config, 'expired');
  const opened = await openOAuthCookie(sealed);
  if (!opened.ok) return fail(config, opened.reason === 'expired' ? 'expired' : 'invalid_state');

  const params = new URL(request.url).searchParams;
  if (!statesMatch(params.get('state'), opened.cookie.state)) return fail(config, 'invalid_state');

  const currentAdmin = await adminId(request);
  if (!currentAdmin || currentAdmin !== opened.cookie.userId) return fail(config, 'session');

  const error = params.get('error');
  if (error) return fail(config, error === 'access_denied' ? 'denied' : 'failed');
  const code = params.get('code');
  if (!code || code.length > 2_048) return fail(config, 'failed');

  try {
    const tokens = await exchangeCode(
      config,
      code,
      opened.cookie.verifier,
      Date.now() + CALLBACK_BUDGET_MS,
    );
    if (!hasRequiredScopes(tokens.scope)) return fail(config, 'scope');
    await saveConnection(opened.cookie.userId, tokens);
  } catch (exchangeError) {
    if (exchangeError instanceof TikTokError && exchangeError.reason === 'rate_limited') {
      return fail(config, 'rate_limited');
    }
    if (!(exchangeError instanceof TikTokError)) {
      // biome-ignore lint/suspicious/noConsole: server log of the error name only (no tokens).
      console.error(
        '[tiktok] callback failed',
        exchangeError instanceof Error ? exchangeError.name : 'unknown',
      );
    }
    return fail(config, 'failed');
  }
  return back(config, 'tiktok=connected');
}
