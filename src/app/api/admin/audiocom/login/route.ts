// @polsia:user-owned — avvia «Collega audio.com» (OAuth 2.1 Authorization Code con PKCE S256).
// Solo amministratori verificati e solo da una navigazione di Solco stesso (Sec-Fetch-Site).
// La prima volta registra Solco presso audio.com come client pubblico (registrazione dinamica,
// nessun segreto) e ne salva il client_id; poi crea state e code_verifier, li mette in un cookie
// HttpOnly cifrato di 10 minuti limitato a /api/admin/audiocom e rimanda alla pagina di
// autorizzazione di audio.com con lo scope "public". Ogni problema torna a /admin/audiocom con un
// motivo fisso (?audiocom=error&reason=…): nessun input riflesso.
import 'server-only';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import { audioComAdminSession, audioComPrivateHeaders } from '@/lib/music/audiocom-admin.server';
import {
  AUDIOCOM_ADMIN_PAGE,
  AudioComError,
  audioComAuthorizeUrl,
  audioComConfig,
  audioComOAuthCookieHeader,
  ensureAudioComClient,
  sealAudioComOAuthCookie,
} from '@/lib/music/audiocom-connection.server';
import { createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';

export const dynamic = 'force-dynamic';

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ ...audioComPrivateHeaders, Location: location });
  headers.set('Referrer-Policy', 'no-referrer');
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(request: Request) {
  const config = audioComConfig();
  if (!config) {
    return Response.json(
      {
        error: 'audiocom_not_configured',
        message:
          'Il collegamento ad audio.com non è configurato (indirizzo https dell’app o chiave di cifratura mancanti).',
      },
      { status: 404, headers: audioComPrivateHeaders },
    );
  }
  const adminPage = `${config.appOrigin}${AUDIOCOM_ADMIN_PAGE}`;
  const fail = (reason: string) => redirect(`${adminPage}?audiocom=error&reason=${reason}`);

  // Solo da un clic dentro Solco (o un indirizzo digitato): mai da un altro sito.
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && !ALLOWED_FETCH_SITES.has(site)) return redirect(adminPage);

  const session = await audioComAdminSession(request);
  if (session.kind === 'signed_out') {
    return redirect(
      `${config.appOrigin}/login?callbackURL=${encodeURIComponent(AUDIOCOM_ADMIN_PAGE)}`,
    );
  }
  if (session.kind !== 'admin') return redirect(adminPage);

  const limited = await consumeRateLimit('audiocom.connect.admin', `user:${session.userId}`);
  if (!limited.allowed) return fail('rate_limited');

  let clientId: string;
  try {
    clientId = await ensureAudioComClient(config);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: log del server col solo motivo dell'errore.
    console.error(
      '[admin/audiocom] registrazione del client non riuscita:',
      error instanceof AudioComError
        ? error.reason
        : error instanceof Error
          ? error.name
          : 'unknown',
    );
    return fail(
      error instanceof AudioComError && error.reason === 'rate_limited'
        ? 'rate_limited'
        : 'registration',
    );
  }

  const state = createOAuthState();
  const verifier = createCodeVerifier();
  const sealed = sealAudioComOAuthCookie({
    state,
    verifier,
    userId: session.userId,
    clientId,
    issuedAt: Date.now(),
  });
  const authorize = await audioComAuthorizeUrl({ config, clientId, state, verifier });
  return redirect(authorize, audioComOAuthCookieHeader(sealed, config));
}
