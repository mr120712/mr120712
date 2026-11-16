// @polsia:user-owned — avvia "Accedi con Spotify" (Authorization Code con PKCE, nessun client secret).
// Crea state e code_verifier, li salva cifrati in un cookie HttpOnly di 10 minuti limitato a
// /api/spotify e rimanda a accounts.spotify.com/authorize con i soli scope necessari.
// Parte solo da una navigazione di Solco stesso (Sec-Fetch-Site; dalla web app iOS, che WebKit può
// marcare cross-site, con Origin/Referer di Solco: own-site-request.ts) e con show_dialog=true: un
// altro sito non può ricollegare in silenzio Spotify dopo che l'utente l'ha scollegato.
import 'server-only';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import {
  isFromOwnSite,
  NAVIGATION_OWN_SITES,
  ownSiteOrigins,
} from '@/lib/security/own-site-request';
import {
  notConfiguredResponse,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_IMPORT_PAGE,
  SPOTIFY_SCOPES,
  spotifyConfig,
  spotifyPrivateHeaders,
} from '@/lib/spotify/config.server';
import { oauthCookieHeader, sealOAuthCookie } from '@/lib/spotify/connection.server';
import { codeChallengeS256, createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';

export const dynamic = 'force-dynamic';

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...spotifyPrivateHeaders, Location: location });
  headers.set('Referrer-Policy', 'no-referrer');
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(request: Request) {
  const config = spotifyConfig();
  if (!config) return notConfiguredResponse();

  // The session cookie is SameSite=Lax, so a link on another site would carry it: never start
  // the flow from there (browsers without Fetch Metadata send no header and are let through).
  // The iOS home-screen web app may be stamped cross-site by WebKit: it passes only with an
  // Origin/Referer of Solco itself (own-site-request.ts).
  const ownOrigins = ownSiteOrigins(
    {
      NEXT_PUBLIC_APP_URL: config.appOrigin,
      BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    },
    request,
  );
  if (!isFromOwnSite(request.headers, ownOrigins, NAVIGATION_OWN_SITES)) {
    return redirect(`${config.appOrigin}${SPOTIFY_IMPORT_PAGE}`);
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return redirect(
      `${config.appOrigin}/login?callbackURL=${encodeURIComponent(SPOTIFY_IMPORT_PAGE)}`,
    );
  }

  const state = createOAuthState();
  const verifier = createCodeVerifier();
  const sealed = await sealOAuthCookie({
    state,
    verifier,
    userId: user.id,
    issuedAt: Date.now(),
  });
  const authorize = new URL(SPOTIFY_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: SPOTIFY_SCOPES.join(' '),
    state,
    code_challenge_method: 'S256',
    code_challenge: await codeChallengeS256(verifier),
    // Always ask for consent, even for a person who approved Solco before.
    show_dialog: 'true',
  }).toString();
  return redirect(authorize.toString(), oauthCookieHeader(sealed, config));
}
