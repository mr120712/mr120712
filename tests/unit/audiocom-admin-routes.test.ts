// @polsia:user-owned — route admin di audio.com: «Collega» (solo admin verificato, solo da Solco,
// registrazione del client una volta, cookie PKCE e redirect ad audio.com), ritorno (rifiuta cookie
// assente/manomesso/scaduto, state sbagliato, sessione non admin o di un altro admin, annullamento;
// con tutto in regola scambia il codice e salva i token cifrati), stato (mai i token) e «Scollega»
// (stessa origine). Collegamento vero (audiocom-connection.server) su un database finto; HTTP finto.
// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  consumeRateLimit: vi.fn(),
  sameOrigin: vi.fn(() => true),
  clearCache: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const fake = await import('./support/audiocom-db-fake');
  return { prisma: fake.sharedAudioComDb.prisma };
});
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/music/audiocom.server', () => ({ clearAudioComSearchCache: mocks.clearCache }));

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-for-audiocom-routes-0123456789abcdef';
  process.env.NEXT_PUBLIC_APP_URL = 'https://solco.test';
});

import { GET as callback } from '@/app/api/admin/audiocom/callback/route';
import { GET as login } from '@/app/api/admin/audiocom/login/route';
import { DELETE, GET as status } from '@/app/api/admin/audiocom/route';
import { AudioComConnectionStatusSchema } from '@/lib/contracts/audiocom';
import {
  AUDIOCOM_OAUTH_COOKIE,
  AUDIOCOM_REGISTRATION_URL,
  AUDIOCOM_TOKEN_URL,
  openAudioComOAuthCookie,
  resetAudioComConnectionMemory,
  sealAudioComOAuthCookie,
} from '@/lib/music/audiocom-connection.server';
import { openAudioComValue, sealAudioComValue } from '@/lib/music/audiocom-crypto.server';
import { createCodeVerifier, createOAuthState } from '@/lib/spotify/pkce';
import { sharedAudioComDb as db } from './support/audiocom-db-fake';

const CLIENT_ID = 'solco-client-xyz';
const ADMIN_PAGE = 'https://solco.test/admin/audiocom';
const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function admin(id = 'admin-1') {
  return { user: { id, role: 'admin', emailVerified: true } };
}

function loginRequest(headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return new Request('https://solco.test/api/admin/audiocom/login', { headers });
}

/** Cookie OAuth valido per l'admin e lo state dati (come lo crea il login). */
function oauthCookie(overrides: Partial<Parameters<typeof sealAudioComOAuthCookie>[0]> = {}) {
  const value = {
    state: createOAuthState(),
    verifier: createCodeVerifier(),
    userId: 'admin-1',
    clientId: CLIENT_ID,
    issuedAt: Date.now(),
    ...overrides,
  };
  return { value, sealed: sealAudioComOAuthCookie(value) };
}

function callbackRequest(params: Record<string, string>, cookie?: string) {
  const url = new URL('https://solco.test/api/admin/audiocom/callback');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, {
    headers: cookie ? { cookie: `${AUDIOCOM_OAUTH_COOKIE}=${cookie}` } : {},
  });
}

beforeEach(() => {
  db.reset();
  resetAudioComConnectionMemory();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mocks.getSession.mockReset().mockResolvedValue(admin());
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.clearCache.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/admin/audiocom/login', () => {
  it('admin verificato: registra il client UNA volta, mette il cookie PKCE e va ad audio.com', async () => {
    fetchMock.mockResolvedValue(json({ client_id: CLIENT_ID }, 201));
    const response = await login(loginRequest());
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://api.audio.com/auth/authorize');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('scope')).toBe('public');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(AUDIOCOM_REGISTRATION_URL);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${AUDIOCOM_OAUTH_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/admin/audiocom');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('audiocom.connect.admin', 'user:admin-1');

    // Il cookie (cifrato) porta lo stesso state e il verifier della challenge S256 dell'indirizzo.
    const sealed = cookie.split(';')[0]?.slice(`${AUDIOCOM_OAUTH_COOKIE}=`.length) ?? '';
    const opened = openAudioComOAuthCookie(sealed);
    if (!opened.ok) throw new Error('cookie non valido');
    expect(opened.cookie).toMatchObject({ userId: 'admin-1', clientId: CLIENT_ID });
    expect(location.searchParams.get('state')).toBe(opened.cookie.state);
    expect(location.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(opened.cookie.verifier).digest('base64url'),
    );

    // Secondo collegamento: il client c'è già, nessuna nuova registrazione.
    await login(loginRequest());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('senza sessione porta al login; un utente non admin (o email non verificata) torna alla pagina', async () => {
    mocks.getSession.mockResolvedValue(null);
    const signedOut = await login(loginRequest());
    expect(signedOut.headers.get('location')).toBe(
      'https://solco.test/login?callbackURL=%2Fadmin%2Faudiocom',
    );
    mocks.getSession.mockResolvedValue({
      user: { id: 'u1', role: 'admin', emailVerified: false },
    });
    const unverified = await login(loginRequest());
    expect(unverified.headers.get('location')).toBe(ADMIN_PAGE);
    expect(unverified.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('da un altro sito non parte (nessuna registrazione, nessun cookie)', async () => {
    const foreign: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site', referer: 'https://altro.example/admin' },
      { 'sec-fetch-site': 'same-site', referer: 'https://altro.solco.test/' },
    ];
    for (const headers of foreign) {
      const response = await login(loginRequest(headers));
      expect(response.headers.get('location'), JSON.stringify(headers)).toBe(ADMIN_PAGE);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dalla web app iOS (Sec-Fetch-Site cross-site, Referer di Solco) parte come da Solco', async () => {
    fetchMock.mockResolvedValue(json({ client_id: CLIENT_ID }, 201));
    const response = await login(
      loginRequest({
        'sec-fetch-site': 'cross-site',
        referer: 'https://solco.test/admin/audiocom',
      }),
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').origin).toBe('https://api.audio.com');
    expect(response.headers.get('set-cookie')).toContain(`${AUDIOCOM_OAUTH_COOKIE}=`);
  });

  it('oltre il limite per admin: torna con reason=rate_limited', async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const response = await login(loginRequest());
    expect(response.headers.get('location')).toBe(
      `${ADMIN_PAGE}?audiocom=error&reason=rate_limited`,
    );
  });
});

describe('GET /api/admin/audiocom/callback', () => {
  it('cookie assente → expired; manomesso → invalid_state; il cookie viene sempre cancellato', async () => {
    const missing = await callback(callbackRequest({ code: 'c', state: 's' }));
    expect(missing.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=expired`);
    expect(missing.headers.get('set-cookie')).toContain('Max-Age=0');

    const { sealed, value } = oauthCookie();
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    const bad = await callback(callbackRequest({ code: 'c', state: value.state }, tampered));
    expect(bad.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=invalid_state`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cookie scaduto → expired', async () => {
    const { sealed, value } = oauthCookie({ issuedAt: Date.now() - 11 * 60_000 });
    const response = await callback(callbackRequest({ code: 'c', state: value.state }, sealed));
    expect(response.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=expired`);
  });

  it('state diverso → invalid_state, senza scambio del codice', async () => {
    const { sealed } = oauthCookie();
    const response = await callback(
      callbackRequest({ code: 'c', state: createOAuthState() }, sealed),
    );
    expect(response.headers.get('location')).toBe(
      `${ADMIN_PAGE}?audiocom=error&reason=invalid_state`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sessione non admin, o di un altro admin → session, senza scambio del codice', async () => {
    const { sealed, value } = oauthCookie();
    mocks.getSession.mockResolvedValue({
      user: { id: 'admin-1', role: 'user', emailVerified: true },
    });
    const notAdmin = await callback(callbackRequest({ code: 'c', state: value.state }, sealed));
    expect(notAdmin.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=session`);
    mocks.getSession.mockResolvedValue(admin('admin-2'));
    const otherAdmin = await callback(callbackRequest({ code: 'c', state: value.state }, sealed));
    expect(otherAdmin.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=session`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('autorizzazione annullata su audio.com → denied', async () => {
    const { sealed, value } = oauthCookie();
    const response = await callback(
      callbackRequest({ error: 'access_denied', state: value.state }, sealed),
    );
    expect(response.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=denied`);
  });

  it('tutto in regola: scambia il codice con il verifier e salva i token cifrati', async () => {
    db.seed({ clientId: CLIENT_ID, redirectUri: 'https://solco.test/api/admin/audiocom/callback' });
    const { sealed, value } = oauthCookie();
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === AUDIOCOM_TOKEN_URL) {
        return json({
          access_token: 'acc-SEGRETO',
          refresh_token: 'ref-SEGRETO',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      // Nome dell'account (best effort): l'audio più recente dell'account.
      return json([{ id: '1', author_name: 'Solco Official', username: 'solco' }]);
    });
    const response = await callback(
      callbackRequest({ code: 'code-1', state: value.state }, sealed),
    );
    expect(response.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=connected`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');

    const tokenCall = fetchMock.mock.calls.find(([url]) => String(url) === AUDIOCOM_TOKEN_URL);
    const form = new URLSearchParams(String(tokenCall?.[1]?.body));
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toBe(value.verifier);
    expect(form.get('client_id')).toBe(CLIENT_ID);

    expect(JSON.stringify(db.writes)).not.toContain('SEGRETO');
    expect(openAudioComValue(db.state.row?.accessToken, `audiocom-access:v1:${CLIENT_ID}`)).toBe(
      'acc-SEGRETO',
    );
    expect(db.state.row?.accountName).toBe('Solco Official');
    expect(mocks.clearCache).toHaveBeenCalled();
  });

  it('codice rifiutato da audio.com → failed, niente salvato', async () => {
    const { sealed, value } = oauthCookie();
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    const response = await callback(callbackRequest({ code: 'c', state: value.state }, sealed));
    expect(response.headers.get('location')).toBe(`${ADMIN_PAGE}?audiocom=error&reason=failed`);
    expect(db.state.row).toBeNull();
  });
});

describe('GET/DELETE /api/admin/audiocom', () => {
  it('stato solo per admin verificati, mai con i token', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await status(new Request('https://solco.test/api/admin/audiocom'))).status).toBe(401);
    mocks.getSession.mockResolvedValue({ user: { id: 'u', role: 'user', emailVerified: true } });
    expect((await status(new Request('https://solco.test/api/admin/audiocom'))).status).toBe(403);

    mocks.getSession.mockResolvedValue(admin());
    db.seed({
      clientId: CLIENT_ID,
      redirectUri: 'https://solco.test/api/admin/audiocom/callback',
      accessToken: sealAudioComValue('acc-SEGRETO', `audiocom-access:v1:${CLIENT_ID}`),
      refreshToken: sealAudioComValue('ref-SEGRETO', `audiocom-refresh:v1:${CLIENT_ID}`),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      accountName: 'Solco Official',
      connectedAt: new Date('2026-11-14T09:00:00Z'),
      lastError: 'rate_limited',
      lastErrorAt: new Date('2026-11-15T08:00:00Z'),
    });
    const response = await status(new Request('https://solco.test/api/admin/audiocom'));
    const text = await response.text();
    expect(text).not.toContain('SEGRETO');
    expect(text).not.toContain(db.state.row?.accessToken ?? '---');
    expect(AudioComConnectionStatusSchema.parse(JSON.parse(text))).toEqual({
      configured: true,
      connected: true,
      needsReconnect: false,
      clientRegistered: true,
      accountName: 'Solco Official',
      connectedAt: '2026-11-14T09:00:00.000Z',
      lastError: 'rate_limited',
      lastErrorAt: '2026-11-15T08:00:00.000Z',
      redirectUri: 'https://solco.test/api/admin/audiocom/callback',
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('Scollega: 403 da un’altra origine; da admin cancella i token e svuota la cache', async () => {
    db.seed({
      clientId: CLIENT_ID,
      accessToken: sealAudioComValue('acc', `audiocom-access:v1:${CLIENT_ID}`),
      refreshToken: sealAudioComValue('ref', `audiocom-refresh:v1:${CLIENT_ID}`),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
    });
    mocks.sameOrigin.mockReturnValue(false);
    const forbidden = await DELETE(
      new Request('https://solco.test/api/admin/audiocom', { method: 'DELETE' }),
    );
    expect(forbidden.status).toBe(403);
    expect(db.state.row?.accessToken).not.toBeNull();

    mocks.sameOrigin.mockReturnValue(true);
    const ok = await DELETE(
      new Request('https://solco.test/api/admin/audiocom', { method: 'DELETE' }),
    );
    expect(ok.status).toBe(200);
    expect(db.state.row).toMatchObject({
      accessToken: null,
      refreshToken: null,
      clientId: CLIENT_ID,
    });
    expect(mocks.clearCache).toHaveBeenCalled();
  });
});
