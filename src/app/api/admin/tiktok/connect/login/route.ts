// @polsia:user-owned — avvia "Collega TikTok" (Login Kit v2, Authorization Code con PKCE). Solo
// amministratori verificati. Crea state e code_verifier, li salva cifrati in un cookie HttpOnly di
// 10 minuti limitato a /api/admin/tiktok e rimanda a www.tiktok.com/v2/auth/authorize con i soli
// scope necessari. Parte solo da una navigazione di Solco stesso (Sec-Fetch-Site).
import 'server-only';
import { auth } from '@/lib/auth';
import { codeChallengeS256, createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';
import {
  notConfiguredResponse,
  TIKTOK_ADMIN_PAGE,
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_SCOPES,
  tiktokConfig,
  tiktokPrivateHeaders,
} from '@/lib/tiktok/config.server';
import { oauthCookieHeader, sealOAuthCookie } from '@/lib/tiktok/connection.server';

export const dynamic = 'force-dynamic';

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...tiktokPrivateHeaders, Location: location });
  headers.set('Referrer-Policy', 'no-referrer');
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(request: Request) {
  const config = tiktokConfig();
  if (!config) return notConfiguredResponse();

  const site = request.headers.get('sec-fetch-site');
  if (site !== null && !ALLOWED_FETCH_SITES.has(site)) {
    return redirect(`${config.appOrigin}${TIKTOK_ADMIN_PAGE}`);
  }

  // Solo un amministratore verificato può collegare l'account TikTok di Solco.
  let userId: string | null = null;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (session?.user?.role === 'admin' && session.user.emailVerified === true) {
      userId = session.user.id;
    } else if (session?.user) {
      return redirect(`${config.appOrigin}${TIKTOK_ADMIN_PAGE}`);
    }
  } catch {
    // Treat an auth error as "no session" below.
  }
  if (!userId) {
    return redirect(
      `${config.appOrigin}/login?callbackURL=${encodeURIComponent(TIKTOK_ADMIN_PAGE)}`,
    );
  }

  const state = createOAuthState();
  const verifier = createCodeVerifier();
  const sealed = await sealOAuthCookie({ state, verifier, userId, issuedAt: Date.now() });
  const authorize = new URL(TIKTOK_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_key: config.clientKey,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: TIKTOK_SCOPES.join(','),
    state,
    code_challenge: await codeChallengeS256(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return redirect(authorize.toString(), oauthCookieHeader(sealed, config));
}
