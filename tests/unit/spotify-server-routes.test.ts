// @polsia:user-owned
// @vitest-environment node
// Spotify import, routes: login → callback (PKCE, cookie checks), connection, playlists, import.
// Spotify and the database are fakes: no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  createdAt: Date;
  updatedAt: Date;
};

const mocks = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const matches = (row: Row, where: { userId: string; refreshToken?: string }) =>
    row.userId === where.userId &&
    (where.refreshToken === undefined || where.refreshToken === row.refreshToken);
  return {
    rows,
    user: { id: 'u1', email: 'a@example.test' } as { id: string; email: string } | null,
    sameOrigin: true,
    limited: vi.fn(async (): Promise<Response | null> => null),
    playlistCount: 0,
    created: [] as Array<{ name: string; items: Array<Record<string, unknown>> }>,
    spotifyConnection: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const row = rows.get(where.userId);
        return row ? { ...row } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId: string };
          create: Omit<Row, 'id' | 'createdAt' | 'updatedAt'>;
          update: Partial<Row>;
        }) => {
          const existing = rows.get(where.userId);
          const now = new Date();
          const row = existing
            ? { ...existing, ...update, updatedAt: now }
            : { id: `c-${where.userId}`, ...create, createdAt: now, updatedAt: now };
          rows.set(where.userId, row);
          return row;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; refreshToken?: string } }) => {
        const row = rows.get(where.userId);
        if (row && matches(row, where)) {
          rows.delete(where.userId);
          return { count: 1 };
        }
        return { count: 0 };
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { userId: string }; data: Partial<Row> }) => {
          const row = rows.get(where.userId);
          if (!row) return { count: 0 };
          rows.set(where.userId, { ...row, ...data, updatedAt: new Date() });
          return { count: 1 };
        },
      ),
    },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({
  getSessionUser: async () => mocks.user,
  requireAuth: async () => {
    if (!mocks.user) throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    return mocks.user;
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.limited }));
vi.mock('@/lib/music/collections.server', () => ({
  MAX_PLAYLISTS_PER_USER: 100,
  isFavoritesName: (name: string) => name === 'Preferiti',
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    spotifyConnection: mocks.spotifyConnection,
    userMusicCollection: {
      count: async () => mocks.playlistCount,
      findFirst: async ({ where }: { where: { name: string } }) =>
        mocks.created.some((playlist) => playlist.name === where.name) ? { id: 'taken' } : null,
      create: async ({
        data,
      }: {
        data: { name: string; items: { create: Array<Record<string, unknown>> } };
      }) => {
        mocks.created.push({ name: data.name, items: data.items.create });
        return { id: `col-${mocks.created.length}` };
      },
    },
  },
}));

import { GET as callbackGET } from '@/app/api/spotify/callback/route';
import {
  DELETE as connectionDELETE,
  GET as connectionGET,
} from '@/app/api/spotify/connection/route';
import { POST as importPOST } from '@/app/api/spotify/import/route';
import { GET as loginGET } from '@/app/api/spotify/login/route';
import { GET as playlistsGET } from '@/app/api/spotify/playlists/route';
import { saveConnection } from '@/lib/spotify/connection.server';
import { codeChallengeS256 } from '@/lib/spotify/pkce';
import { openValue } from '@/lib/spotify/token-crypto.server';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://solco.test';
const PLAYLIST_A = '37i9dQZF1DXcBWIGoYBM5M';
const PLAYLIST_B = '5ABHKGoOzxkaa28ttQV9sE';
const PLAYLIST_C = '1A2b3C4d5E6f7G8h9I0jKl';
const PLAYLIST_D = '37i9dQZF1DX0XUsuxWHRQd';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let spotify: Handler;
const fetchMock = vi.fn<typeof fetch>(async (input, init) => spotify(new URL(String(input)), init));
const bodies: string[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function read(response: Response) {
  const text = await response.clone().text();
  bodies.push(text);
  return text ? JSON.parse(text) : null;
}

function track(n: number, extra: Record<string, unknown> = {}) {
  const id = `${String(n).padStart(4, '0')}${'x'.repeat(18)}`;
  return {
    type: 'track',
    id,
    name: `Brano ${n}`,
    duration_ms: 180_000 + n,
    is_local: false,
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    artists: [{ name: `Artista ${n}` }],
    ...extra,
  };
}

async function connect(userId = 'u1', expiresInMs = 3_600_000, scope = SCOPES) {
  await saveConnection(userId, {
    accessToken: 'ACCESS-OLD',
    refreshToken: 'REFRESH-OLD',
    expiresAt: new Date(Date.now() + expiresInMs),
    scope,
  });
}

const request = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  vi.stubEnv('SPOTIFY_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-spotify-tokens');
  vi.stubEnv('SPOTIFY_TOKEN_KEY', '');
  mocks.rows.clear();
  for (const spy of Object.values(mocks.spotifyConnection)) spy.mockClear();
  mocks.user = { id: 'u1', email: 'a@example.test' };
  mocks.sameOrigin = true;
  mocks.playlistCount = 0;
  mocks.created = [];
  mocks.limited.mockReset().mockResolvedValue(null);
  spotify = () => json({ error: { status: 500, message: 'unexpected call' } }, 500);
});

afterEach(() => {
  // No route may ever return a Spotify token.
  for (const body of bodies.splice(0)) {
    expect(body).not.toMatch(/ACCESS-|REFRESH-/);
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('funzione spenta', () => {
  it('senza SPOTIFY_CLIENT_ID le route rispondono 404 e la UI resta nascosta', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_ID', '');
    for (const response of [
      await loginGET(request('/api/spotify/login')),
      await callbackGET(request('/api/spotify/callback?code=x&state=y')),
      await playlistsGET(request('/api/spotify/playlists')),
      await importPOST(request('/api/spotify/import', { method: 'POST', body: '{"saved":true}' })),
    ]) {
      expect(response.status).toBe(404);
      expect((await read(response)).error).toBe('spotify_not_configured');
    }
    const status = await connectionGET();
    expect(await read(status)).toEqual({
      configured: false,
      connected: false,
      needsReconnect: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('login e callback (PKCE)', () => {
  async function login() {
    const response = await loginGET(request('/api/spotify/login'));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    const setCookie = response.headers.get('set-cookie') ?? '';
    const cookie = /^solco_spotify_oauth=([^;]+)/.exec(setCookie)?.[1] ?? '';
    return { location, setCookie, cookie };
  }

  const callback = (query: string, cookie?: string) =>
    callbackGET(
      request(`/api/spotify/callback?${query}`, {
        headers: cookie ? { cookie: `other=1; solco_spotify_oauth=${cookie}` } : {},
      }),
    );

  it('chiede di accedere a Solco prima di collegare Spotify', async () => {
    mocks.user = null;
    const response = await loginGET(request('/api/spotify/login'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login?callbackURL=%2Flibrary`);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rimanda a Spotify con PKCE S256, scope minimi e un cookie HttpOnly di 10 minuti', async () => {
    const { location, setCookie, cookie } = await login();
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.spotify.com/authorize');
    const params = location.searchParams;
    expect(params.get('client_id')).toBe(CLIENT_ID);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('redirect_uri')).toBe(`${ORIGIN}/api/spotify/callback`);
    expect(params.get('scope')).toBe(SCOPES);
    expect(params.get('code_challenge_method')).toBe('S256');
    // Spotify always asks for consent, even after a disconnect.
    expect(params.get('show_dialog')).toBe('true');
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/spotify');
    expect(setCookie).toContain('Max-Age=600');
    // The cookie is encrypted: neither the state nor the verifier is readable.
    expect(cookie).toMatch(/^v1\./);
    expect(cookie).not.toContain(params.get('state'));
    const opened = await openValue(cookie, 'spotify-oauth-cookie-v1');
    const verifier = JSON.parse(opened ?? '{}').v as string;
    expect(verifier).toHaveLength(64);
    expect(params.get('code_challenge')).toBe(await codeChallengeS256(verifier));
  });

  it('non parte da un altro sito (Sec-Fetch-Site), ma sì da Solco o da un link digitato', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await loginGET(
        request('/api/spotify/login', { headers: { 'sec-fetch-site': site } }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get('location') ?? '';
      expect(location).toBe(`${ORIGIN}/library`);
      expect(location).not.toContain('accounts.spotify.com');
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    for (const site of ['same-origin', 'none']) {
      const response = await loginGET(
        request('/api/spotify/login', { headers: { 'sec-fetch-site': site } }),
      );
      expect(new URL(response.headers.get('location') ?? '').origin).toBe(
        'https://accounts.spotify.com',
      );
      expect(response.headers.get('set-cookie')).toMatch(/^solco_spotify_oauth=v1\./);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scambia il codice con il code_verifier e salva i token cifrati', async () => {
    const { location, cookie } = await login();
    const verifier = JSON.parse((await openValue(cookie, 'spotify-oauth-cookie-v1')) ?? '{}').v;
    let tokenBody = '';
    let tokenHeaders = new Headers();
    spotify = async (url, init) => {
      if (url.href === 'https://accounts.spotify.com/api/token') {
        tokenBody = String(init?.body);
        tokenHeaders = new Headers(init?.headers);
        return json({
          access_token: 'ACCESS-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'REFRESH-1',
          scope: 'user-library-read playlist-read-collaborative playlist-read-private',
        });
      }
      if (url.pathname === '/v1/me/tracks') return json({ total: 10, items: [] });
      return json({}, 500);
    };
    const state = location.searchParams.get('state');
    const response = await callback(`code=AUTH-CODE&state=${state}`, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/library?spotify=connected`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(tokenHeaders.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(tokenHeaders.get('authorization')).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(tokenBody))).toEqual({
      grant_type: 'authorization_code',
      code: 'AUTH-CODE',
      redirect_uri: `${ORIGIN}/api/spotify/callback`,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    });
    const row = mocks.rows.get('u1');
    expect(row?.accessToken).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toMatch(/ACCESS-1|REFRESH-1/);
    expect(await openValue(row?.refreshToken ?? '', 'spotify-refresh:u1')).toBe('REFRESH-1');
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('rifiuta cookie assenti, manomessi, scaduti, state diversi e altri utenti', async () => {
    const { location, cookie } = await login();
    const state = location.searchParams.get('state');
    const reason = async (response: Response) =>
      new URL(response.headers.get('location') ?? '').searchParams.get('reason');

    expect(await reason(await callback(`code=c&state=${state}`))).toBe('expired');
    expect(await reason(await callback(`code=c&state=${state}`, `${cookie.slice(0, -3)}abc`))).toBe(
      'invalid_state',
    );
    expect(await reason(await callback(`code=c&state=${'B'.repeat(43)}`, cookie))).toBe(
      'invalid_state',
    );
    mocks.user = { id: 'u2', email: 'b@example.test' };
    expect(await reason(await callback(`code=c&state=${state}`, cookie))).toBe('session');
    mocks.user = null;
    expect(await reason(await callback(`code=c&state=${state}`, cookie))).toBe('session');
    mocks.user = { id: 'u1', email: 'a@example.test' };
    expect(await reason(await callback(`error=access_denied&state=${state}`, cookie))).toBe(
      'denied',
    );
    // Untrusted input is never reflected: a fixed reason only.
    const odd = await callback(`error=%3Cscript%3E&state=${state}`, cookie);
    expect(odd.headers.get('location')).toBe(`${ORIGIN}/library?spotify=error&reason=failed`);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await reason(await callback(`code=c&state=${state}`, cookie))).toBe('expired');
    vi.useRealTimers();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(0);
  });

  it('segnala subito gli account Spotify non abilitati (modalità sviluppo)', async () => {
    const { location, cookie } = await login();
    spotify = (url) =>
      url.hostname === 'accounts.spotify.com'
        ? json({
            access_token: 'ACCESS-1',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'REFRESH-1',
            scope: SCOPES,
          })
        : json(
            {
              error: {
                status: 403,
                message:
                  'Check settings on developer.spotify.com/dashboard, the user may not be registered.',
              },
            },
            403,
          );
    const response = await callback(`code=c&state=${location.searchParams.get('state')}`, cookie);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/library?spotify=error&reason=not_allowlisted`,
    );
    expect(mocks.rows.size).toBe(0);
  });

  it('rifiuta un consenso senza playlist-read-collaborative (le playlist collaborative mancherebbero)', async () => {
    const { location, cookie } = await login();
    spotify = (url) =>
      url.hostname === 'accounts.spotify.com'
        ? json({
            access_token: 'ACCESS-1',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'REFRESH-1',
            scope: 'playlist-read-private user-library-read',
          })
        : json({ total: 0, items: [] });
    const response = await callback(`code=c&state=${location.searchParams.get('state')}`, cookie);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/library?spotify=error&reason=failed`);
    expect(mocks.rows.size).toBe(0);
  });
});

describe('collegamento', () => {
  it('dice se Spotify è collegato e lo scollega cancellando i token', async () => {
    const off = { configured: true, connected: false, needsReconnect: false };
    expect(await read(await connectionGET())).toEqual(off);
    await connect();
    const status = await connectionGET();
    expect(status.headers.get('cache-control')).toContain('no-store');
    expect(await read(status)).toEqual({
      configured: true,
      connected: true,
      needsReconnect: false,
    });

    mocks.sameOrigin = false;
    expect(
      (await connectionDELETE(request('/api/spotify/connection', { method: 'DELETE' }))).status,
    ).toBe(403);
    expect(mocks.rows.size).toBe(1);
    mocks.sameOrigin = true;
    const removed = await connectionDELETE(
      request('/api/spotify/connection', { method: 'DELETE' }),
    );
    expect(await read(removed)).toEqual(off);
    expect(mocks.rows.size).toBe(0);
    mocks.user = null;
    expect(await read(await connectionGET())).toEqual(off);
  });

  it('chiede di ricollegare un consenso precedente senza playlist-read-collaborative', async () => {
    // A connection made before the scope was added: refreshes keep this grant forever.
    await connect('u1', 3_600_000, 'playlist-read-private user-library-read');
    expect(await read(await connectionGET())).toEqual({
      configured: true,
      connected: true,
      needsReconnect: true,
    });

    const list = await playlistsGET(request('/api/spotify/playlists'));
    expect(list.status).toBe(401);
    const body = await read(list);
    expect(body.error).toBe('spotify_scope_outdated');
    expect(body.message).toContain('Ricollega Spotify');
    expect(body.message).toContain('collaboratore');

    const imported = await importPOST(
      request('/api/spotify/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playlistIds: [PLAYLIST_B] }),
      }),
    );
    expect(imported.status).toBe(401);
    expect((await read(imported)).error).toBe('spotify_scope_outdated');
    expect(mocks.created).toEqual([]);
    // Nothing is read from Spotify with the old grant, and the row stays for "Disconnetti".
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.rows.size).toBe(1);

    // An old row refreshed by Spotify with the old scope still asks for a reconnect.
    await connect('u1', -1_000, 'playlist-read-private user-library-read');
    expect((await playlistsGET(request('/api/spotify/playlists'))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    // Reconnecting stores the new grant: the list works again.
    await connect();
    spotify = (url) =>
      json(url.pathname === '/v1/me/tracks' ? { total: 3 } : { total: 0, items: [] });
    expect((await playlistsGET(request('/api/spotify/playlists'))).status).toBe(200);
    expect((await read(await connectionGET())).needsReconnect).toBe(false);
  });
});

describe('elenco delle playlist', () => {
  it('legge 20 playlist e il totale dei brani salvati, senza salvarli', async () => {
    await connect();
    const seen: string[] = [];
    // Only /me/playlists and /me/tracks are answered: any other request would fail the list.
    spotify = (url, init) => {
      seen.push(`${url.pathname}${url.search}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ACCESS-OLD');
      if (url.pathname === '/v1/me/playlists') {
        return json({
          total: 45,
          items: [
            {
              id: PLAYLIST_A,
              name: 'Estate',
              collaborative: false,
              owner: { id: 'ada', display_name: 'Ada' },
              images: [{ url: 'https://i.scdn.co/image/a', width: 300, height: 300 }],
              items: { total: 12 },
              external_urls: { spotify: `https://open.spotify.com/playlist/${PLAYLIST_A}` },
            },
            null,
            {
              // Followed only: Spotify leaves `items` out.
              id: PLAYLIST_B,
              name: 'Di Bruno',
              collaborative: false,
              owner: { id: 'bruno', display_name: 'Bruno' },
            },
            {
              // Another user's playlist the listener collaborates on: `items` is there.
              id: PLAYLIST_C,
              name: 'Insieme',
              collaborative: false,
              owner: { id: 'carla', display_name: 'Carla' },
              items: { total: 7 },
            },
            {
              id: PLAYLIST_D,
              name: 'Hot Hits Italia',
              owner: { id: 'spotify', display_name: 'Spotify' },
              items: { total: 50 },
            },
          ],
        });
      }
      if (url.pathname === '/v1/me/tracks') return json({ total: 321, items: [] });
      return json({ error: { status: 404, message: 'Not found' } }, 404);
    };
    const response = await playlistsGET(request('/api/spotify/playlists?offset=20'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(await read(response)).toEqual({
      playlists: [
        {
          id: PLAYLIST_A,
          name: 'Estate',
          owner: 'Ada',
          imageUrl: 'https://i.scdn.co/image/a',
          itemCount: 12,
          spotifyUrl: `https://open.spotify.com/playlist/${PLAYLIST_A}`,
          importable: true,
        },
        {
          id: PLAYLIST_B,
          name: 'Di Bruno',
          owner: 'Bruno',
          imageUrl: null,
          itemCount: null,
          spotifyUrl: `https://open.spotify.com/playlist/${PLAYLIST_B}`,
          // Followed, not owned: Spotify answers 403 to /items, so it cannot be chosen.
          importable: false,
        },
        {
          id: PLAYLIST_C,
          name: 'Insieme',
          owner: 'Carla',
          imageUrl: null,
          itemCount: 7,
          spotifyUrl: `https://open.spotify.com/playlist/${PLAYLIST_C}`,
          importable: true,
        },
        {
          id: PLAYLIST_D,
          name: 'Hot Hits Italia',
          owner: 'Spotify',
          imageUrl: null,
          itemCount: 50,
          spotifyUrl: `https://open.spotify.com/playlist/${PLAYLIST_D}`,
          importable: false,
        },
      ],
      savedTracks: 321,
      nextOffset: 40,
    });
    // Two requests per page: no /me profile lookup.
    expect(seen.sort()).toEqual(['/v1/me/playlists?limit=20&offset=20', '/v1/me/tracks?limit=1']);
    expect(mocks.limited).toHaveBeenCalledWith('spotify.read', 'user:u1');
    expect(mocks.spotifyConnection.upsert).toHaveBeenCalledTimes(1); // only connect()
    expect(mocks.spotifyConnection.updateMany).not.toHaveBeenCalled();
  });

  it('chiede di collegare Spotify, rifiuta offset non validi e rispetta il limite di Solco', async () => {
    const missing = await playlistsGET(request('/api/spotify/playlists'));
    expect(missing.status).toBe(401);
    expect((await read(missing)).error).toBe('spotify_reauth');
    expect((await playlistsGET(request('/api/spotify/playlists?offset=-1'))).status).toBe(400);
    expect((await playlistsGET(request('/api/spotify/playlists?offset=200001'))).status).toBe(400);
    mocks.limited.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    const limited = await playlistsGET(request('/api/spotify/playlists'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toContain('no-store');
    mocks.user = null;
    expect((await playlistsGET(request('/api/spotify/playlists'))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rinnova il token in scadenza e salva il refresh token ruotato', async () => {
    await connect('u1', 30_000); // expires within 60 s
    let refreshBody = '';
    spotify = (url, init) => {
      if (url.hostname === 'accounts.spotify.com') {
        refreshBody = String(init?.body);
        return json({
          access_token: 'ACCESS-NEW',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'REFRESH-NEW',
          scope: SCOPES,
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ACCESS-NEW');
      return json({ total: 0, items: [] });
    };
    const response = await playlistsGET(request('/api/spotify/playlists'));
    expect(response.status).toBe(200);
    expect(Object.fromEntries(new URLSearchParams(refreshBody))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'REFRESH-OLD',
      client_id: CLIENT_ID,
    });
    const row = mocks.rows.get('u1');
    expect(await openValue(row?.refreshToken ?? '', 'spotify-refresh:u1')).toBe('REFRESH-NEW');
    expect(await openValue(row?.accessToken ?? '', 'spotify-access:u1')).toBe('ACCESS-NEW');
    // A refresh without a new refresh token keeps the stored one.
    mocks.rows.set('u1', { ...(row as Row), expiresAt: new Date(Date.now() - 1) });
    spotify = (url) =>
      url.hostname === 'accounts.spotify.com'
        ? json({ access_token: 'ACCESS-3', token_type: 'Bearer', expires_in: 3600 })
        : json({ total: 0, items: [] });
    expect((await playlistsGET(request('/api/spotify/playlists'))).status).toBe(200);
    expect(await openValue(mocks.rows.get('u1')?.refreshToken ?? '', 'spotify-refresh:u1')).toBe(
      'REFRESH-NEW',
    );
  });

  it('con un refresh token non più valido cancella il collegamento e chiede di ricollegare', async () => {
    await connect('u1', -1_000);
    spotify = (url) =>
      url.hostname === 'accounts.spotify.com'
        ? json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400)
        : json({}, 500);
    const response = await playlistsGET(request('/api/spotify/playlists'));
    expect(response.status).toBe(401);
    expect(await read(response)).toMatchObject({ error: 'spotify_reauth' });
    expect(mocks.rows.size).toBe(0);
  });

  it('spiega il 403 della modalità sviluppo e il 429 di Spotify', async () => {
    await connect();
    spotify = () =>
      json(
        {
          error: {
            status: 403,
            message:
              'Check settings on developer.spotify.com/dashboard, the user may not be registered.',
          },
        },
        403,
      );
    const forbidden = await playlistsGET(request('/api/spotify/playlists'));
    expect(forbidden.status).toBe(403);
    const body = await read(forbidden);
    expect(body.error).toBe('spotify_not_allowlisted');
    expect(body.message).toContain('User Management');
    expect(mocks.rows.size).toBe(1);

    spotify = () =>
      json({ error: { status: 429, message: 'Too many requests' } }, 429, { 'Retry-After': '120' });
    const limited = await playlistsGET(request('/api/spotify/playlists'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('120');
    expect(await read(limited)).toMatchObject({
      error: 'spotify_rate_limited',
      retryAfterSeconds: 120,
    });
  });
});

describe('importazione', () => {
  const post = (body: unknown) =>
    importPOST(
      request('/api/spotify/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('crea una playlist di Solco per ogni sorgente, leggendo /items a pagine di 50', async () => {
    await connect();
    const calls: URL[] = [];
    spotify = (url) => {
      calls.push(url);
      if (url.pathname === `/v1/playlists/${PLAYLIST_A}`) return json({ name: 'Estate 2026' });
      if (url.pathname === `/v1/playlists/${PLAYLIST_A}/items`) {
        return json({
          total: 6,
          items: [
            { is_local: false, item: track(1) },
            { is_local: true, item: track(2, { is_local: true }) },
            { is_local: false, item: { ...track(3), type: 'episode' } },
            { is_local: false, item: null },
            { is_local: false, item: track(1) }, // duplicate
            { is_local: false, item: track(4) },
          ],
        });
      }
      if (url.pathname === '/v1/me/tracks') {
        return json({ total: 1, items: [{ added_at: '2026-01-01T00:00:00Z', track: track(9) }] });
      }
      return json({}, 500);
    };
    const response = await post({ playlistIds: [PLAYLIST_A], saved: true });
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({
      created: [
        {
          collectionId: 'col-1',
          name: 'Estate 2026',
          imported: 2,
          skipped: 4,
          truncated: 0,
          source: PLAYLIST_A,
        },
        {
          collectionId: 'col-2',
          name: 'Brani salvati su Spotify',
          imported: 1,
          skipped: 0,
          truncated: 0,
          source: 'saved',
        },
      ],
      failed: [],
    });
    const items = calls.find((url) => url.pathname.endsWith('/items'));
    expect(items?.searchParams.get('limit')).toBe('50');
    expect(items?.searchParams.get('offset')).toBe('0');
    expect(items?.searchParams.get('fields')).toContain('item(type,id,name,duration_ms');
    expect(
      calls.some((url) => url.pathname.endsWith('/tracks') && url.pathname.includes('/playlists/')),
    ).toBe(false);
    expect(mocks.created[0]?.items.map((item) => item.title)).toEqual(['Brano 1', 'Brano 4']);
    expect(mocks.created[0]?.items[0]).toMatchObject({
      source: 'song',
      creatorName: 'Artista 1',
      durationSeconds: 180,
      sourceUrl: `https://open.spotify.com/track/0001${'x'.repeat(18)}`,
    });
    expect(mocks.limited).toHaveBeenCalledWith('library.import', 'user:u1');
  });

  it('si ferma a 200 brani per playlist (4 pagine) e conta gli altri come oltre il limite', async () => {
    await connect();
    const offsets: string[] = [];
    spotify = (url) => {
      if (url.pathname === `/v1/playlists/${PLAYLIST_A}`) return json({ name: 'Enorme' });
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(String(offset));
      return json({
        total: 1000,
        items: Array.from({ length: 50 }, (_, i) => ({ is_local: false, item: track(offset + i) })),
      });
    };
    const body = await read(await post({ playlistIds: [PLAYLIST_A], saved: false }));
    expect(offsets).toEqual(['0', '50', '100', '150']);
    expect(body.created[0]).toMatchObject({ imported: 200, truncated: 800, skipped: 0 });
  });

  it('riporta le playlist non leggibili senza fermare le altre', async () => {
    await connect();
    spotify = (url) => {
      if (url.pathname === `/v1/playlists/${PLAYLIST_A}`) return json({ name: 'Di un amico' });
      if (url.pathname === `/v1/playlists/${PLAYLIST_A}/items`) {
        return json({ error: { status: 403, message: 'Forbidden' } }, 403);
      }
      if (url.pathname === `/v1/playlists/${PLAYLIST_B}`) return json({ name: 'Mia' });
      return json({ total: 1, items: [{ is_local: false, item: track(5) }] });
    };
    const body = await read(await post({ playlistIds: [PLAYLIST_A, PLAYLIST_B], saved: false }));
    expect(body.created.map((playlist: { name: string }) => playlist.name)).toEqual(['Mia']);
    expect(body.failed).toEqual([
      expect.objectContaining({ source: PLAYLIST_A, error: 'spotify_forbidden' }),
    ]);
    expect(body.failed[0].message).toBe(
      'Spotify consente di leggere solo le playlist che hai creato o di cui sei collaboratore.',
    );
  });

  it('rispetta il massimo di playlist, l’origine, il corpo e la sessione', async () => {
    await connect();
    mocks.playlistCount = 100;
    const full = await post({ playlistIds: [PLAYLIST_A], saved: false });
    expect(full.status).toBe(409);
    expect((await read(full)).error).toBe('limit_reached');
    mocks.playlistCount = 99;
    const almost = await post({ playlistIds: [PLAYLIST_A], saved: true });
    expect(almost.status).toBe(409);
    expect((await read(almost)).message).toContain('ancora 1');
    mocks.playlistCount = 0;

    expect((await post({ playlistIds: [], saved: false })).status).toBe(400);
    expect((await post({ playlistIds: ['nope'], saved: false })).status).toBe(400);
    const tooBig = await importPOST(
      request('/api/spotify/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playlistIds: [PLAYLIST_A], saved: false, pad: 'x'.repeat(3000) }),
      }),
    );
    expect(tooBig.status).toBe(413);
    expect(tooBig.headers.get('cache-control')).toContain('no-store');

    mocks.sameOrigin = false;
    expect((await post({ saved: true })).status).toBe(403);
    mocks.sameOrigin = true;
    mocks.user = null;
    expect((await post({ saved: true })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.created).toHaveLength(0);
  });
});
