// @polsia:user-owned — avvia "Connetti YouTube" (Authorization Code + PKCE, client confidenziale).
// Crea state e code_verifier, li salva cifrati in un cookie HttpOnly di 10 minuti limitato a
// /api/music/youtube e rimanda a accounts.google.com con i soli scope necessari e access_type=
// offline + prompt=consent (per ottenere il refresh token). Parte solo da una navigazione di Solco
// stesso (Sec-Fetch-Site / own-site-request): un altro sito non può ricollegare in silenzio YouTube.
import 'server-only';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  isFromOwnSite,
  NAVIGATION_OWN_SITES,
  ownSiteOrigins,
} from '@/lib/security/own-site-request';
import { codeChallengeS256, createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';
import {
  GOOGLE_AUTHORIZE_URL,
  notConfiguredResponse,
  YOUTUBE_ACCOUNT_SCOPES,
  YOUTUBE_IMPORT_PAGE,
  youtubeAccountConfig,
  youtubePrivateHeaders,
} from '@/lib/youtube-account/config.server';
import { oauthCookieHeader, sealOAuthCookie } from '@/lib/youtube-account/connection.server';

export const dynamic = 'force-dynamic';

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...youtubePrivateHeaders, Location: location });
  headers.set('Referrer-Policy', 'no-referrer');
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(request: Request) {
  const config = youtubeAccountConfig();
  if (!config) return notConfiguredResponse();

  const ownOrigins = ownSiteOrigins(
    {
      NEXT_PUBLIC_APP_URL: config.appOrigin,
      BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    },
    request,
  );
  if (!isFromOwnSite(request.headers, ownOrigins, NAVIGATION_OWN_SITES)) {
    return redirect(`${config.appOrigin}${YOUTUBE_IMPORT_PAGE}`);
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return redirect(
      `${config.appOrigin}/login?callbackURL=${encodeURIComponent(YOUTUBE_IMPORT_PAGE)}`,
    );
  }

  const state = createOAuthState();
  const verifier = createCodeVerifier();
  const sealed = await sealOAuthCookie({ state, verifier, userId: user.id, issuedAt: Date.now() });
  const authorize = new URL(GOOGLE_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: YOUTUBE_ACCOUNT_SCOPES.join(' '),
    state,
    code_challenge_method: 'S256',
    code_challenge: await codeChallengeS256(verifier),
    // offline + consent: necessari perché Google rilasci un refresh token ogni volta.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  }).toString();
  return redirect(authorize.toString(), oauthCookieHeader(sealed, config));
}
