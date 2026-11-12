// @polsia:user-owned
// @vitest-environment node
// Spotify import, server units: PKCE, token encryption, configuration, Web API client (retry,
// errors) and mapping of Spotify objects. No network: fetch is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/music/collections.server', () => ({
  MAX_PLAYLISTS_PER_USER: 100,
  isFavoritesName: (name: string) => name === 'Preferiti',
}));

import { deleteAccountData } from '@/lib/business/account-deletion';
import { SpotifyImportRequestSchema } from '@/lib/contracts/spotify';
import {
  backoffDelay,
  describeSpotifyError,
  SpotifyError,
  spotifyFetch,
} from '@/lib/spotify/client.server';
import { redirectOrigin, spotifyConfig } from '@/lib/spotify/config.server';
import {
  openOAuthCookie,
  refreshAccessToken,
  sealOAuthCookie,
  statesMatch,
} from '@/lib/spotify/connection.server';
import {
  listSpotifyPlaylists,
  mapPlaylist,
  mapSpotifyTrack,
  pickImage,
} from '@/lib/spotify/import.server';
import {
  base64UrlDecode,
  CODE_VERIFIER_ALPHABET,
  codeChallengeS256,
  createCodeVerifier,
  createOAuthState,
} from '@/lib/spotify/pkce';
import { hasTokenKey, openValue, sealValue } from '@/lib/spotify/token-crypto.server';

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.stubEnv('SPOTIFY_CLIENT_ID', '0123456789abcdef0123456789abcdef');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://solco.test');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-spotify-tokens');
  vi.stubEnv('SPOTIFY_TOKEN_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PKCE', () => {
  it('calcola il code_challenge S256 del vettore di prova della RFC 7636 (Appendice B)', async () => {
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('genera verifier di 64 caratteri ammessi e state di 32 byte casuali', () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(64);
    expect([...verifier].every((char) => CODE_VERIFIER_ALPHABET.includes(char))).toBe(true);
    expect(createCodeVerifier()).not.toBe(verifier);
    const state = createOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64UrlDecode(state)).toHaveLength(32);
    expect(() => createCodeVerifier(42)).toThrow(RangeError);
  });
});

describe('cifratura dei token', () => {
  it('cifra e decifra, e rifiuta valori manomessi o di un altro contesto', async () => {
    const sealed = await sealValue('BQD-access-token', 'spotify-access:u1');
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('BQD-access-token');
    expect(await openValue(sealed, 'spotify-access:u1')).toBe('BQD-access-token');
    // Same plaintext, different IV.
    expect(await sealValue('BQD-access-token', 'spotify-access:u1')).not.toBe(sealed);
    // Another user's row or another purpose.
    expect(await openValue(sealed, 'spotify-access:u2')).toBeNull();
    const [version, iv, ciphertext] = sealed.split('.');
    const flipped = `${ciphertext?.[0] === 'A' ? 'B' : 'A'}${ciphertext?.slice(1)}`;
    expect(await openValue(`${version}.${iv}.${flipped}`, 'spotify-access:u1')).toBeNull();
    expect(await openValue('v2.abc.def', 'spotify-access:u1')).toBeNull();
    expect(await openValue('garbage', 'spotify-access:u1')).toBeNull();
    expect(await openValue(`${sealed}.extra`, 'spotify-access:u1')).toBeNull();
  });

  it('usa SPOTIFY_TOKEN_KEY se presente e la rifiuta se non è di 32 byte', async () => {
    const sealedWithSecret = await sealValue('token', 'ctx');
    vi.stubEnv('SPOTIFY_TOKEN_KEY', Buffer.alloc(32, 7).toString('base64'));
    expect(hasTokenKey()).toBe(true);
    expect(await openValue(sealedWithSecret, 'ctx')).toBeNull();
    const sealedWithKey = await sealValue('token', 'ctx');
    expect(await openValue(sealedWithKey, 'ctx')).toBe('token');
    vi.stubEnv('SPOTIFY_TOKEN_KEY', Buffer.alloc(16, 7).toString('base64'));
    expect(hasTokenKey()).toBe(false);
    expect(spotifyConfig()).toBeNull();
  });
});

describe('configurazione', () => {
  it('è spenta senza SPOTIFY_CLIENT_ID o senza una chiave', () => {
    expect(spotifyConfig()).toMatchObject({
      clientId: '0123456789abcdef0123456789abcdef',
      redirectUri: 'https://solco.test/api/spotify/callback',
      secureCookies: true,
    });
    vi.stubEnv('SPOTIFY_CLIENT_ID', '');
    expect(spotifyConfig()).toBeNull();
    vi.stubEnv('SPOTIFY_CLIENT_ID', '0123456789abcdef0123456789abcdef');
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    expect(spotifyConfig()).toBeNull();
  });

  it('accetta solo redirect HTTPS o http://127.0.0.1, mai localhost o wildcard', () => {
    expect(redirectOrigin('https://solcomusic.vercel.app/')).toBe('https://solcomusic.vercel.app');
    expect(redirectOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(redirectOrigin('http://localhost:3000')).toBeNull();
    expect(redirectOrigin('https://localhost')).toBeNull();
    expect(redirectOrigin('http://solco.test')).toBeNull();
    expect(redirectOrigin('https://*.vercel.app')).toBeNull();
    expect(redirectOrigin('https://user:pw@solco.test')).toBeNull();
    expect(redirectOrigin(undefined)).toBeNull();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    expect(spotifyConfig()).toBeNull();
  });
});

describe('cookie OAuth', () => {
  const cookie = {
    state: 'A'.repeat(43),
    verifier: 'v'.repeat(64),
    userId: 'u1',
    issuedAt: 1_700_000_000_000,
  };

  it('si apre solo intatto, entro 10 minuti', async () => {
    const sealed = await sealOAuthCookie(cookie);
    expect(await openOAuthCookie(sealed, cookie.issuedAt + 1_000)).toEqual({ ok: true, cookie });
    expect(await openOAuthCookie(sealed, cookie.issuedAt + 601_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await openOAuthCookie(`${sealed.slice(0, -2)}xx`, cookie.issuedAt)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // A token ciphertext is not a valid cookie (different context).
    const token = await sealValue(JSON.stringify({ s: cookie.state }), 'spotify-access:u1');
    expect((await openOAuthCookie(token, cookie.issuedAt)).ok).toBe(false);
  });

  it('confronta lo state in tempo costante', () => {
    expect(statesMatch('A'.repeat(43), 'A'.repeat(43))).toBe(true);
    expect(statesMatch('B'.repeat(43), 'A'.repeat(43))).toBe(false);
    expect(statesMatch('A', 'A'.repeat(43))).toBe(false);
    expect(statesMatch(null, 'A'.repeat(43))).toBe(false);
  });
});

describe('client Spotify', () => {
  it('rispetta Retry-After su 429 (nessun nuovo tentativo prima)', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        json({ error: { status: 429, message: 'Too many requests' } }, 429, { 'Retry-After': '2' }),
      )
      .mockResolvedValueOnce(json({ total: 3, items: [] }));
    const result = spotifyFetch('/me/tracks?limit=1', { accessToken: 'tok' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ total: 3, items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.spotify.com/v1/me/tracks?limit=1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('con Retry-After 0 non riprova subito: aspetta almeno il backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock
      .mockResolvedValueOnce(
        json({ error: { status: 429, message: 'Too many requests' } }, 429, { 'Retry-After': '0' }),
      )
      .mockResolvedValueOnce(json({ total: 1, items: [] }));
    const result = spotifyFetch('/me/tracks?limit=1', { accessToken: 'tok' });
    await vi.advanceTimersByTimeAsync(749);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ total: 1, items: [] });
  });

  it('smette dopo 3 nuovi tentativi o oltre 15 s di attesa', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () =>
      json({ error: { status: 429, message: 'Too many requests' } }, 429, { 'Retry-After': '1' }),
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const capped = spotifyFetch('/me/playlists', { accessToken: 'tok' }).catch((error) => error);
    // Retry-After 1 s, but never less than the backoff: 1 s, 2 s, 4 s.
    await vi.advanceTimersByTimeAsync(7_000);
    const error = await capped;
    expect(error).toBeInstanceOf(SpotifyError);
    expect(error).toMatchObject({ status: 429, reason: 'rate_limited', retryAfter: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      json({ error: { status: 429, message: 'Too many requests' } }, 429, { 'Retry-After': '20' }),
    );
    // 20 s is beyond the 15 s budget: no wait at all, the caller tells the person.
    await expect(spotifyFetch('/me/playlists', { accessToken: 'tok' })).rejects.toMatchObject({
      status: 429,
      retryAfter: 20,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      describeSpotifyError(
        new SpotifyError({ status: 429, reason: 'rate_limited', retryAfter: 20 }),
      ),
    ).toMatchObject({ status: 429, error: 'spotify_rate_limited', retryAfterSeconds: 20 });
  });

  it('su 429 QUOTA_EXCEEDED non riprova e spiega la quota della modalità sviluppo', async () => {
    vi.useFakeTimers();
    const quota = (headers: Record<string, string> = {}) =>
      json(
        { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } },
        429,
        headers,
      );
    fetchMock.mockImplementation(async () => quota());
    const error = await spotifyFetch('/me/playlists', { accessToken: 'tok' }).catch((e) => e);
    // One call only: a retry would spend more of the exhausted quota.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      status: 429,
      reason: 'quota_exceeded',
      spotifyMessage: 'Too many requests',
      retryAfter: null,
    });
    const described = describeSpotifyError(error);
    expect(described).toMatchObject({ status: 429, error: 'spotify_quota_exceeded' });
    expect(described.message).toContain('modalità sviluppo');
    expect(described.message).toContain('Spotify: “Too many requests”');
    expect(described.message).not.toContain('secondi');
    expect(described).not.toHaveProperty('retryAfterSeconds');

    // Retry-After, when present, is passed on (still without any retry).
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => quota({ 'Retry-After': '2' }));
    const timed = await spotifyFetch('/me/playlists', { accessToken: 'tok' }).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(describeSpotifyError(timed)).toMatchObject({
      error: 'spotify_quota_exceeded',
      retryAfterSeconds: 2,
    });

    // The token endpoint is treated the same way.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => quota());
    const config = spotifyConfig();
    if (!config) throw new Error('Spotify should be configured in this test');
    await expect(refreshAccessToken(config, 'REFRESH')).rejects.toMatchObject({
      status: 429,
      reason: 'quota_exceeded',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('senza Retry-After attende 1 s, 2 s, 4 s con jitter', async () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1_000);
    expect(backoffDelay(1, () => 0.5)).toBe(2_000);
    expect(backoffDelay(2, () => 0.5)).toBe(4_000);
    expect(backoffDelay(0, () => 0)).toBe(750);
    expect(backoffDelay(0, () => 1)).toBe(1_250);
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchMock.mockImplementation(async () =>
      json({ error: { status: 503, message: 'busy' } }, 503),
    );
    const failing = spotifyFetch('/me/playlists', { accessToken: 'tok' }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await failing).toMatchObject({
      status: 503,
      reason: 'unavailable',
      spotifyMessage: 'busy',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('su 401 rinnova il token una sola volta e riprova', async () => {
    const refresh = vi.fn(async () => 'fresh');
    const auth = { accessToken: 'stale', refresh };
    fetchMock
      .mockResolvedValueOnce(
        json({ error: { status: 401, message: 'The access token expired' } }, 401),
      )
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(spotifyFetch('/me/tracks?limit=1', auth)).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(auth.accessToken).toBe('fresh');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer fresh',
    );

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      json({ error: { status: 401, message: 'Invalid access token' } }, 401),
    );
    await expect(spotifyFetch('/me/tracks', { accessToken: 'x', refresh })).rejects.toMatchObject({
      reason: 'reauth',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('riconosce gli utenti fuori dalla allowlist (modalità sviluppo) e gli altri errori', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            status: 403,
            message:
              'Check settings on developer.spotify.com/dashboard, the user may not be registered.',
          },
        },
        403,
      ),
    );
    const error = await spotifyFetch('/playlists/37i9dQZF1DXcBWIGoYBM5M/items', {
      accessToken: 'tok',
    }).catch((e) => e);
    expect(error).toMatchObject({ status: 403, reason: 'not_allowlisted' });
    const described = describeSpotifyError(error);
    expect(described.error).toBe('spotify_not_allowlisted');
    expect(described.message).toContain('5');
    expect(described.message).toContain('Settings → User Management');

    fetchMock.mockResolvedValueOnce(json({ error: { status: 403, message: 'Forbidden' } }, 403));
    const forbidden = await spotifyFetch('/playlists/37i9dQZF1DXcBWIGoYBM5M/items', {
      accessToken: 'tok',
    }).catch((e) => e);
    expect(forbidden).toMatchObject({ reason: 'forbidden', spotifyMessage: 'Forbidden' });
    // A bare reason phrase is not appended to the Italian sentence.
    expect(describeSpotifyError(forbidden).message).toBe(
      'Spotify consente di leggere solo le playlist che hai creato o di cui sei collaboratore.',
    );
    expect(
      describeSpotifyError(
        new SpotifyError({ status: 403, reason: 'forbidden', spotifyMessage: 'Not allowed here' }),
      ).message,
    ).toContain('(Spotify: “Not allowed here”)');
    expect(
      describeSpotifyError(
        new SpotifyError({
          status: 503,
          reason: 'unavailable',
          spotifyMessage: 'Service Unavailable',
        }),
      ).message,
    ).toBe('Spotify non risponde al momento. Riprova tra qualche minuto.');
    fetchMock.mockResolvedValueOnce(json({ error: { status: 403, message: 'Forbidden' } }, 403));
    await expect(spotifyFetch('/me/playlists', { accessToken: 'tok' })).rejects.toMatchObject({
      reason: 'not_allowlisted',
    });
    fetchMock.mockResolvedValueOnce(
      json({ error: { status: 404, message: 'Resource not found' } }, 404),
    );
    const missing = await spotifyFetch('/playlists/x', { accessToken: 'tok' }).catch((e) => e);
    expect(describeSpotifyError(missing).message).toContain('Spotify: “Resource not found”');
    fetchMock.mockResolvedValueOnce(
      json({ error: { status: 400, message: 'Invalid limit' } }, 400),
    );
    await expect(spotifyFetch('/me/playlists', { accessToken: 'tok' })).rejects.toMatchObject({
      status: 400,
      reason: 'bad_request',
      spotifyMessage: 'Invalid limit',
    });
  });
});

describe('mappatura degli oggetti Spotify', () => {
  const track = {
    type: 'track',
    id: '4uLU6hMCjMI75M1A2tKUQC',
    name: '  Never   Gonna\u0000 Give You Up ',
    duration_ms: 213_573,
    is_local: false,
    external_urls: { spotify: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' },
    artists: [{ name: 'Rick Astley' }, { name: 'Band Finta' }, null],
  };

  it('trasforma un TrackObject e scarta file locali, episodi e elementi vuoti', () => {
    expect(mapSpotifyTrack(track)).toEqual({
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley, Band Finta',
      durationSeconds: 214,
      sourceUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    });
    expect(mapSpotifyTrack(track, true)).toBeNull();
    expect(mapSpotifyTrack({ ...track, is_local: true })).toBeNull();
    expect(mapSpotifyTrack({ ...track, type: 'episode' })).toBeNull();
    expect(mapSpotifyTrack(null)).toBeNull();
    expect(mapSpotifyTrack({ ...track, name: '   ' })).toBeNull();
    expect(mapSpotifyTrack({ ...track, id: null, external_urls: null, artists: [] })).toEqual({
      title: 'Never Gonna Give You Up',
      artist: null,
      durationSeconds: 214,
      sourceUrl: null,
    });
  });

  it('mostra le playlist come le fornisce Spotify, con link e copertina ≥ 64 px', () => {
    expect(
      mapPlaylist({
        id: '37i9dQZF1DXcBWIGoYBM5M',
        name: 'Today’s Top Hits',
        owner: { id: 'spotify', display_name: 'Spotify' },
        images: [
          { url: 'https://i.scdn.co/image/large', width: 640, height: 640 },
          { url: 'https://i.scdn.co/image/small', width: 60, height: 60 },
          { url: 'https://i.scdn.co/image/medium', width: 300, height: 300 },
        ],
        items: { total: 50 },
        tracks: { total: 999 },
        external_urls: { spotify: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' },
      }),
    ).toEqual({
      id: '37i9dQZF1DXcBWIGoYBM5M',
      name: 'Today’s Top Hits',
      owner: 'Spotify',
      imageUrl: 'https://i.scdn.co/image/medium',
      itemCount: 50,
      spotifyUrl: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      // Spotify's own editorial playlists cannot be read by the app.
      importable: false,
    });
    expect(pickImage([{ url: 'https://mosaic.scdn.co/640/x', width: null, height: null }])).toBe(
      'https://mosaic.scdn.co/640/x',
    );
    expect(pickImage([{ url: 'http://insecure.test/a', width: 300, height: 300 }])).toBeNull();
    expect(pickImage([])).toBeNull();
    expect(
      mapPlaylist({
        id: '37i9dQZF1DXcBWIGoYBM5M',
        name: 'X',
        external_urls: { spotify: 'https://evil.test' },
      })?.spotifyUrl,
    ).toBe('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(mapPlaylist({ id: 'bad', name: 'X' })).toBeNull();
    expect(mapPlaylist(null)).toBeNull();
  });

  it('segna come non importabili le playlist soltanto seguite (senza `items`)', () => {
    const importable = (raw: Record<string, unknown>) =>
      mapPlaylist({ id: '5ABHKGoOzxkaa28ttQV9sE', name: 'P', ...raw })?.importable;
    const items = { total: 3 };
    // Spotify returns `items` only for playlists the listener owns or collaborates on.
    expect(importable({ owner: { id: 'ada' }, items })).toBe(true);
    // Another user's playlist with `items`: the listener collaborates on it, whatever
    // `collaborative` says (that attribute is not the same as having collaborators).
    for (const collaborative of [true, false, null, undefined]) {
      expect(importable({ owner: { id: 'bruno' }, collaborative, items })).toBe(true);
    }
    expect(importable({ owner: { id: 'bruno' }, items: {} })).toBe(true);
    // Without `items`: merely followed, /items would answer 403.
    for (const collaborative of [true, false, undefined]) {
      expect(importable({ owner: { id: 'bruno' }, collaborative })).toBe(false);
      expect(importable({ owner: { id: 'bruno' }, collaborative, items: null })).toBe(false);
    }
    expect(importable({ owner: { id: 'ada' } })).toBe(false);
    // Spotify's own playlists are never readable, even with `items`.
    expect(importable({ owner: { id: 'spotify' }, items })).toBe(false);
    expect(importable({ owner: { id: 'spotify' } })).toBe(false);
    // Unknown or missing owner: `items` alone decides.
    expect(importable({ owner: { display_name: 'Bruno' }, items })).toBe(true);
    expect(importable({ owner: null, items })).toBe(true);
    expect(importable({ items })).toBe(true);
    expect(importable({ owner: null })).toBe(false);
  });

  it('elenca le playlist con due sole richieste: /me/playlists e /me/tracks', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/me/playlists') {
        return json({
          total: 2,
          items: [
            {
              id: '5ABHKGoOzxkaa28ttQV9sE',
              name: 'Mia',
              owner: { id: 'ada' },
              items: { total: 4 },
            },
            { id: '1A2b3C4d5E6f7G8h9I0jKl', name: 'Seguita', owner: { id: 'bruno' } },
          ],
        });
      }
      if (url.pathname === '/v1/me/tracks') return json({ total: 5, items: [] });
      // The listener's profile (or anything else) is never needed for the list.
      return json({ error: { status: 404, message: 'Not found' } }, 404);
    });
    const result = await listSpotifyPlaylists({ accessToken: 'tok' }, 0);
    expect(result.savedTracks).toBe(5);
    expect(result.nextOffset).toBeNull();
    expect(result.playlists.map(({ name, importable }) => ({ name, importable }))).toEqual([
      { name: 'Mia', importable: true },
      { name: 'Seguita', importable: false },
    ]);
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname).sort()).toEqual([
      '/v1/me/playlists',
      '/v1/me/tracks',
    ]);
  });
});

describe('richiesta di importazione', () => {
  const id = (n: number) => `${'A'.repeat(21)}${n}`;

  it('accetta da 1 a 5 sorgenti valide, senza doppioni', () => {
    expect(
      SpotifyImportRequestSchema.safeParse({ playlistIds: [id(1)], saved: false }).success,
    ).toBe(true);
    expect(SpotifyImportRequestSchema.safeParse({ saved: true }).success).toBe(true);
    expect(SpotifyImportRequestSchema.safeParse({ playlistIds: [], saved: false }).success).toBe(
      false,
    );
    expect(
      SpotifyImportRequestSchema.safeParse({ playlistIds: [1, 2, 3, 4, 5].map(id), saved: true })
        .success,
    ).toBe(false);
    expect(
      SpotifyImportRequestSchema.safeParse({ playlistIds: [id(1), id(1)], saved: false }).success,
    ).toBe(false);
    expect(
      SpotifyImportRequestSchema.safeParse({ playlistIds: ['../../me'], saved: false }).success,
    ).toBe(false);
    expect(
      SpotifyImportRequestSchema.safeParse({ playlistIds: [id(1)], saved: false, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('cancellazione dell’account', () => {
  it('elimina anche il collegamento Spotify', async () => {
    const calls: string[] = [];
    const owned = (name: string) => ({
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        calls.push(`${name}:${where.userId}`);
      },
    });
    const transaction = new Proxy(
      {},
      {
        get: (_target, name: string) =>
          name === 'user'
            ? { delete: async () => calls.push('user') }
            : {
                deleteMany: async (args: { where: { userId?: string } }) =>
                  owned(name).deleteMany({ where: { userId: args.where.userId ?? '*' } }),
              },
      },
    );
    await deleteAccountData(transaction as never, 'u9', 'a@example.test');
    expect(calls).toContain('spotifyConnection:u9');
    expect(calls.at(-1)).toBe('user');
  });
});
