// @polsia:user-owned — ritorno da audio.com dopo «Collega audio.com». Verifica il cookie OAuth
// (cifrato e autenticato, 10 minuti), lo state in tempo costante e che la sessione sia ANCORA quella
// dello stesso amministratore verificato; poi scambia il codice con il code_verifier (PKCE, client
// pubblico) e salva i token CIFRATI. Rimanda sempre a /admin/audiocom con ?audiocom=connected
// oppure ?audiocom=error&reason=<motivo fisso>: nessun input riflesso, cookie sempre cancellato.
import 'server-only';
import { clearAudioComSearchCache } from '@/lib/music/audiocom.server';
import { audioComAdminSession, audioComPrivateHeaders } from '@/lib/music/audiocom-admin.server';
import {
  AUDIOCOM_ADMIN_PAGE,
  type AudioComConfig,
  AudioComError,
  audioComConfig,
  audioComStatesMatch,
  clearAudioComOAuthCookieHeader,
  exchangeAudioComCode,
  fetchAudioComAccountName,
  openAudioComOAuthCookie,
  readAudioComOAuthCookie,
  saveAudioComConnection,
} from '@/lib/music/audiocom-connection.server';

export const dynamic = 'force-dynamic';

type Reason = 'expired' | 'invalid_state' | 'session' | 'denied' | 'failed' | 'rate_limited';

function back(config: AudioComConfig, query: string): Response {
  const headers = new Headers({
    ...audioComPrivateHeaders,
    Location: `${config.appOrigin}${AUDIOCOM_ADMIN_PAGE}?${query}`,
    // L'URL di ritorno porta il codice: non farlo trapelare alla pagina successiva.
    'Referrer-Policy': 'no-referrer',
  });
  headers.append('Set-Cookie', clearAudioComOAuthCookieHeader(config));
  return new Response(null, { status: 302, headers });
}

function fail(config: AudioComConfig, reason: Reason): Response {
  return back(config, `audiocom=error&reason=${reason}`);
}

export async function GET(request: Request) {
  const config = audioComConfig();
  if (!config) {
    return Response.json(
      { error: 'audiocom_not_configured' },
      { status: 404, headers: audioComPrivateHeaders },
    );
  }

  const sealed = readAudioComOAuthCookie(request);
  if (!sealed) return fail(config, 'expired');
  const opened = openAudioComOAuthCookie(sealed);
  if (!opened.ok) return fail(config, opened.reason === 'expired' ? 'expired' : 'invalid_state');

  const params = new URL(request.url).searchParams;
  if (!audioComStatesMatch(params.get('state'), opened.cookie.state)) {
    return fail(config, 'invalid_state');
  }

  // La sessione deve essere ancora quella dello stesso amministratore verificato.
  const session = await audioComAdminSession(request);
  if (session.kind !== 'admin' || session.userId !== opened.cookie.userId) {
    return fail(config, 'session');
  }

  const error = params.get('error');
  if (error) return fail(config, error === 'access_denied' ? 'denied' : 'failed');
  const code = params.get('code');
  if (!code || code.length > 2_048) return fail(config, 'failed');

  try {
    const tokens = await exchangeAudioComCode({
      clientId: opened.cookie.clientId,
      redirectUri: config.redirectUri,
      code,
      verifier: opened.cookie.verifier,
    });
    const accountName = await fetchAudioComAccountName(tokens.accessToken);
    await saveAudioComConnection({
      clientId: opened.cookie.clientId,
      redirectUri: config.redirectUri,
      tokens,
      accountName,
    });
    // Le ricerche "non collegato" in memoria non valgono più.
    clearAudioComSearchCache();
  } catch (exchangeError) {
    if (exchangeError instanceof AudioComError && exchangeError.reason === 'rate_limited') {
      return fail(config, 'rate_limited');
    }
    // biome-ignore lint/suspicious/noConsole: log del server col solo motivo dell'errore (mai token).
    console.error(
      '[admin/audiocom] collegamento non riuscito:',
      exchangeError instanceof AudioComError
        ? exchangeError.reason
        : exchangeError instanceof Error
          ? exchangeError.name
          : 'unknown',
    );
    return fail(config, 'failed');
  }
  return back(config, 'audiocom=connected');
}
