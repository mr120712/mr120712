// @polsia:user-owned — collegamento ad audio.com (audiocom-connection.server): registrazione
// dinamica del client UNA volta, PKCE S256, cookie OAuth cifrato e a scadenza, scambio del codice
// (client pubblico, niente segreto), token salvati CIFRATI (nessun token in chiaro nei payload
// Prisma), rinnovo single-flight con rotazione del refresh token e lease fra istanze, refresh token
// già ruotato da un'altra istanza, «Scollega». HTTP sempre finto: nessun account audio.com.
// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const fake = await import('./support/audiocom-db-fake');
  return { prisma: fake.sharedAudioComDb.prisma };
});

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-for-audiocom-connection-0123456789abcdef';
  process.env.NEXT_PUBLIC_APP_URL = 'https://solco.test';
});

import {
  AUDIOCOM_AUTHORIZE_URL,
  AUDIOCOM_OAUTH_COOKIE,
  AUDIOCOM_REGISTRATION_URL,
  AUDIOCOM_TOKEN_URL,
  AudioComError,
  audioComAuthorizeUrl,
  audioComConfig,
  audioComConnectionStatus,
  audioComOAuthCookieHeader,
  audioComStatesMatch,
  clearAudioComOAuthCookieHeader,
  disconnectAudioCom,
  ensureAudioComClient,
  exchangeAudioComCode,
  getAudioComAccessToken,
  markAudioComAccessRejected,
  openAudioComOAuthCookie,
  readAudioComOAuthCookie,
  resetAudioComConnectionMemory,
  saveAudioComConnection,
  sealAudioComOAuthCookie,
} from '@/lib/music/audiocom-connection.server';
import { openAudioComValue, sealAudioComValue } from '@/lib/music/audiocom-crypto.server';
import { createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';
import { sharedAudioComDb as db } from './support/audiocom-db-fake';

const CLIENT_ID = 'solco-client-123';
const accessCtx = `audiocom-access:v1:${CLIENT_ID}`;
const refreshCtx = `audiocom-refresh:v1:${CLIENT_ID}`;
const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function config() {
  const value = audioComConfig();
  if (!value) throw new Error('config assente');
  return value;
}

/** Riga collegata con token cifrati: access in scadenza fra `accessInMs`. */
function seedConnected(accessInMs: number, extra: Partial<Parameters<typeof db.seed>[0]> = {}) {
  db.seed({
    clientId: CLIENT_ID,
    redirectUri: 'https://solco.test/api/admin/audiocom/callback',
    accessToken: sealAudioComValue('access-old', accessCtx),
    refreshToken: sealAudioComValue('refresh-old', refreshCtx),
    accessExpiresAt: new Date(Date.now() + accessInMs),
    connectedAt: new Date('2026-11-01T10:00:00Z'),
    tokenVersion: 3,
    ...extra,
  });
}

function writesText() {
  return JSON.stringify(db.writes);
}

beforeEach(() => {
  db.reset();
  resetAudioComConnectionMemory();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('configurazione', () => {
  it('redirect_uri = <NEXT_PUBLIC_APP_URL>/api/admin/audiocom/callback e cookie Secure in https', () => {
    expect(config()).toEqual({
      appOrigin: 'https://solco.test',
      redirectUri: 'https://solco.test/api/admin/audiocom/callback',
      secureCookies: true,
    });
  });

  it('spenta senza BETTER_AUTH_SECRET (niente token salvabili) o senza indirizzo https', () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.BETTER_AUTH_SECRET = '';
      expect(audioComConfig()).toBeNull();
      process.env.BETTER_AUTH_SECRET = secret;
      process.env.NEXT_PUBLIC_APP_URL = 'http://solco.test';
      expect(audioComConfig()).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = secret;
      process.env.NEXT_PUBLIC_APP_URL = appUrl;
    }
  });
});

describe('registrazione dinamica del client', () => {
  it('registra UNA volta un client pubblico (auth none) con il redirect_uri e salva il client_id', async () => {
    fetchMock.mockResolvedValue(json({ client_id: CLIENT_ID }, 201));
    const [first, second] = await Promise.all([
      ensureAudioComClient(config()),
      ensureAudioComClient(config()),
    ]);
    expect(first).toBe(CLIENT_ID);
    expect(second).toBe(CLIENT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(AUDIOCOM_REGISTRATION_URL);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      redirect_uris: ['https://solco.test/api/admin/audiocom/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'public',
    });
    expect(db.state.row?.clientId).toBe(CLIENT_ID);

    // Già registrato: nessuna nuova chiamata.
    expect(await ensureAudioComClient(config())).toBe(CLIENT_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('registra di nuovo solo se cambia l’indirizzo di ritorno (e i vecchi token si cancellano)', async () => {
    seedConnected(3_600_000, { redirectUri: 'https://vecchio.test/api/admin/audiocom/callback' });
    fetchMock.mockResolvedValue(json({ client_id: 'nuovo-client' }, 201));
    expect(await ensureAudioComClient(config())).toBe('nuovo-client');
    expect(db.state.row).toMatchObject({
      clientId: 'nuovo-client',
      accessToken: null,
      refreshToken: null,
    });
  });

  it('rifiuta una risposta senza client_id e segnala il 429', async () => {
    fetchMock.mockResolvedValueOnce(json({ nope: true }, 201));
    await expect(ensureAudioComClient(config())).rejects.toMatchObject({
      reason: 'invalid_response',
    });
    fetchMock.mockResolvedValueOnce(json({ error: 'slow_down' }, 429));
    await expect(ensureAudioComClient(config())).rejects.toMatchObject({ reason: 'rate_limited' });
  });
});

describe('PKCE e cookie OAuth', () => {
  it('l’indirizzo di autorizzazione porta code_challenge S256 = BASE64URL(SHA256(verifier))', async () => {
    const verifier = createCodeVerifier();
    const state = createOAuthState();
    const url = new URL(
      await audioComAuthorizeUrl({ config: config(), clientId: CLIENT_ID, state, verifier }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(AUDIOCOM_AUTHORIZE_URL);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://solco.test/api/admin/audiocom/callback',
      scope: 'public',
      state,
      code_challenge: expected,
      code_challenge_method: 'S256',
    });
    // Il verifier non viaggia mai nell'indirizzo.
    expect(url.toString()).not.toContain(verifier);
  });

  it('il cookie è cifrato (verifier illeggibile), si riapre, scade dopo 10 minuti e rifiuta manomissioni', () => {
    const cookie = {
      state: createOAuthState(),
      verifier: createCodeVerifier(),
      userId: 'admin-1',
      clientId: CLIENT_ID,
      issuedAt: Date.now(),
    };
    const sealed = sealAudioComOAuthCookie(cookie);
    expect(sealed).not.toContain(cookie.verifier);
    expect(sealed).not.toContain(cookie.state);

    const opened = openAudioComOAuthCookie(sealed);
    expect(opened).toEqual({ ok: true, cookie });

    expect(openAudioComOAuthCookie(sealed, cookie.issuedAt + 11 * 60_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const tampered = `${sealed.slice(0, -3)}${sealed.endsWith('AAA') ? 'BBB' : 'AAA'}`;
    expect(openAudioComOAuthCookie(tampered)).toEqual({ ok: false, reason: 'invalid' });
    // Un token cifrato non vale come cookie (contesto diverso).
    expect(openAudioComOAuthCookie(sealAudioComValue('x', accessCtx))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // Emesso "nel futuro": rifiutato.
    const future = sealAudioComOAuthCookie({ ...cookie, issuedAt: Date.now() + 5 * 60_000 });
    expect(openAudioComOAuthCookie(future)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('cookie HttpOnly, Secure, SameSite=Lax, 10 minuti, solo /api/admin/audiocom; lettura e cancellazione', () => {
    const header = audioComOAuthCookieHeader('valore', config());
    expect(header).toBe(
      `${AUDIOCOM_OAUTH_COOKIE}=valore; Path=/api/admin/audiocom; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(clearAudioComOAuthCookieHeader(config())).toContain('Max-Age=0');
    const request = new Request('https://solco.test/x', {
      headers: { cookie: `altro=1; ${AUDIOCOM_OAUTH_COOKIE}=abc.def; ultimo=2` },
    });
    expect(readAudioComOAuthCookie(request)).toBe('abc.def');
  });

  it('confronta lo state in tempo costante', () => {
    const state = createOAuthState();
    expect(audioComStatesMatch(state, state)).toBe(true);
    expect(audioComStatesMatch(`${state}x`, state)).toBe(false);
    expect(audioComStatesMatch(null, state)).toBe(false);
  });
});

describe('scambio del codice', () => {
  it('POST form con authorization_code, code_verifier e client_id (nessun client_secret)', async () => {
    fetchMock.mockResolvedValue(
      json({
        access_token: 'acc-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'ref-1',
        scope: 'public',
      }),
    );
    const now = Date.parse('2026-11-15T10:00:00Z');
    const tokens = await exchangeAudioComCode({
      clientId: CLIENT_ID,
      redirectUri: 'https://solco.test/api/admin/audiocom/callback',
      code: 'code-xyz',
      verifier: 'v'.repeat(64),
      now,
    });
    expect(tokens).toEqual({
      accessToken: 'acc-1',
      refreshToken: 'ref-1',
      accessExpiresAt: new Date(now + 3_600_000),
      scope: 'public',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(AUDIOCOM_TOKEN_URL);
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-xyz',
      redirect_uri: 'https://solco.test/api/admin/audiocom/callback',
      client_id: CLIENT_ID,
      code_verifier: 'v'.repeat(64),
    });
    expect(form.has('client_secret')).toBe(false);
  });

  it('invalid_grant → reauth, 429 → rate_limited, token_type diverso da Bearer → invalid_response', async () => {
    const input = {
      clientId: CLIENT_ID,
      redirectUri: 'https://solco.test/cb',
      code: 'c',
      verifier: 'v',
    };
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(exchangeAudioComCode(input)).rejects.toMatchObject({ reason: 'reauth' });
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await expect(exchangeAudioComCode(input)).rejects.toMatchObject({ reason: 'rate_limited' });
    fetchMock.mockResolvedValueOnce(json({ access_token: 'a', token_type: 'mac' }));
    await expect(exchangeAudioComCode(input)).rejects.toBeInstanceOf(AudioComError);
  });
});

describe('token salvati cifrati', () => {
  it('nessun token in chiaro nei payload Prisma; si decifrano solo nel loro contesto', async () => {
    await saveAudioComConnection({
      clientId: CLIENT_ID,
      redirectUri: 'https://solco.test/api/admin/audiocom/callback',
      tokens: {
        accessToken: 'segreto-access-AAA',
        refreshToken: 'segreto-refresh-BBB',
        accessExpiresAt: new Date(Date.now() + 3_600_000),
        scope: 'public',
      },
      accountName: 'Solco Music',
    });
    expect(writesText()).not.toContain('segreto-access-AAA');
    expect(writesText()).not.toContain('segreto-refresh-BBB');
    const row = db.state.row;
    expect(openAudioComValue(row?.accessToken, accessCtx)).toBe('segreto-access-AAA');
    expect(openAudioComValue(row?.refreshToken, refreshCtx)).toBe('segreto-refresh-BBB');
    // Scambiati fra colonne non si decifrano.
    expect(openAudioComValue(row?.accessToken, refreshCtx)).toBeNull();
    expect(row?.tokenVersion).toBe(1);

    const status = await audioComConnectionStatus();
    expect(status).toMatchObject({
      configured: true,
      connected: true,
      accountName: 'Solco Music',
      clientRegistered: true,
      lastError: null,
    });
    expect(JSON.stringify(status)).not.toContain('segreto');
  });
});

describe('access token per la ricerca', () => {
  it('usa il token salvato finché vale, senza chiamare audio.com, e lo tiene in memoria', async () => {
    seedConnected(3_600_000);
    expect(await getAudioComAccessToken()).toEqual({ ok: true, token: 'access-old', version: 3 });
    const reads = db.calls.findUnique;
    expect(await getAudioComAccessToken()).toMatchObject({ ok: true, token: 'access-old' });
    expect(db.calls.findUnique).toBe(reads);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('senza collegamento → disconnected (niente chiamate)', async () => {
    expect(await getAudioComAccessToken()).toEqual({ ok: false, reason: 'disconnected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rinnovo single-flight: due richieste insieme → UN refresh; il refresh token ruotato si salva cifrato', async () => {
    seedConnected(30_000); // dentro il margine di 60 s: va rinnovato
    fetchMock.mockResolvedValue(
      json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
    );
    const [a, b] = await Promise.all([getAudioComAccessToken(), getAudioComAccessToken()]);
    expect(a).toEqual({ ok: true, token: 'access-new', version: 4 });
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
      client_id: CLIENT_ID,
    });
    const row = db.state.row;
    expect(row?.tokenVersion).toBe(4);
    expect(row?.refreshLockedUntil).toBeNull();
    expect(openAudioComValue(row?.refreshToken, refreshCtx)).toBe('refresh-new');
    expect(openAudioComValue(row?.accessToken, accessCtx)).toBe('access-new');
    expect(writesText()).not.toContain('access-new');
    expect(writesText()).not.toContain('refresh-new');
  });

  it('se audio.com non manda un refresh token nuovo si tiene quello di prima', async () => {
    seedConnected(-1_000);
    fetchMock.mockResolvedValue(json({ access_token: 'access-new', expires_in: 3600 }));
    expect(await getAudioComAccessToken()).toMatchObject({ ok: true, token: 'access-new' });
    expect(openAudioComValue(db.state.row?.refreshToken, refreshCtx)).toBe('refresh-old');
  });

  it('invalid_grant senza rotazioni altrui → token cancellati, «ricollega», disconnected', async () => {
    seedConnected(-1_000);
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    expect(await getAudioComAccessToken()).toEqual({ ok: false, reason: 'disconnected' });
    expect(db.state.row).toMatchObject({
      accessToken: null,
      refreshToken: null,
      clientId: CLIENT_ID,
      lastError: 'reauth_required',
    });
    const status = await audioComConnectionStatus();
    expect(status).toMatchObject({ connected: false, needsReconnect: true });
  });

  it('refresh token già ruotato da un’altra istanza: usa i token nuovi, NON scollega', async () => {
    seedConnected(-1_000);
    fetchMock.mockImplementation(async () => {
      // Nel frattempo un'altra istanza ha rinnovato (lease scaduto) e salvato token nuovi.
      const row = db.state.row;
      if (row) {
        row.accessToken = sealAudioComValue('access-other', accessCtx);
        row.refreshToken = sealAudioComValue('refresh-other', refreshCtx);
        row.accessExpiresAt = new Date(Date.now() + 3_600_000);
        row.tokenVersion = 9;
      }
      return json({ error: 'invalid_grant' }, 400);
    });
    expect(await getAudioComAccessToken()).toEqual({
      ok: true,
      token: 'access-other',
      version: 9,
    });
    expect(openAudioComValue(db.state.row?.refreshToken, refreshCtx)).toBe('refresh-other');
  });

  it('lease tenuto da un’altra istanza: non rinnova, aspetta e usa il token che quella salva', async () => {
    vi.useFakeTimers();
    seedConnected(-1_000, { refreshLockedUntil: new Date(Date.now() + 10_000) });
    const pending = getAudioComAccessToken();
    await vi.advanceTimersByTimeAsync(450);
    // L'altra istanza finisce il rinnovo.
    const row = db.state.row;
    if (row) {
      row.accessToken = sealAudioComValue('access-other', accessCtx);
      row.accessExpiresAt = new Date(Date.now() + 3_600_000);
      row.tokenVersion = 4;
      row.refreshLockedUntil = null;
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: true, token: 'access-other', version: 4 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errore temporaneo del rinnovo: lease liberato, si usa il token non ancora scaduto', async () => {
    seedConnected(30_000);
    fetchMock.mockResolvedValue(json({ error: 'server_error' }, 503));
    expect(await getAudioComAccessToken()).toMatchObject({ ok: true, token: 'access-old' });
    expect(db.state.row?.refreshLockedUntil).toBeNull();
    expect(db.state.row?.lastError).toBe('refresh_failed');
  });

  it('401 alla ricerca: il token si considera scaduto (solo se nessuno lo ha già cambiato)', async () => {
    seedConnected(3_600_000);
    await markAudioComAccessRejected(2); // versione vecchia: nessun effetto
    expect(db.state.row?.accessExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    await markAudioComAccessRejected(3);
    expect(db.state.row?.accessExpiresAt?.getTime()).toBe(0);
  });
});

describe('Scollega', () => {
  it('cancella i token, tiene il client registrato; poi la ricerca è disconnected', async () => {
    seedConnected(3_600_000);
    expect(await getAudioComAccessToken()).toMatchObject({ ok: true });
    await disconnectAudioCom();
    expect(db.state.row).toMatchObject({
      clientId: CLIENT_ID,
      accessToken: null,
      refreshToken: null,
      accountName: null,
    });
    expect(await getAudioComAccessToken()).toEqual({ ok: false, reason: 'disconnected' });
    expect(await audioComConnectionStatus()).toMatchObject({
      connected: false,
      needsReconnect: false,
      clientRegistered: true,
    });
  });
});
