// @polsia:user-owned — proxy di streaming dei brani in evidenza: percorsi ammessi, sessione
// obbligatoria (401), hotlinking e navigazione diretta rifiutati (403), limite per account solo
// sugli avvii (non sui blocchi di seek), file privato letto con il token e file pubblico dal CDN,
// Range inoltrato, 404 se il blob manca.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  token: 'tok_test' as string | undefined,
  user: { id: 'u1' } as { id: string } | null,
  enforceRateLimit: vi.fn(async () => null as Response | null),
  listing: { audio: [] as Array<{ pathname: string; url: string }> },
}));

// Il route importa `get`; home-tracks.server (per isHomeAudioBlob) importa `list` + env.
vi.mock('@vercel/blob', () => ({ get: mocks.get, list: mocks.list }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: async () => mocks.user }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock('@/lib/music/featured-catalog.server', () => ({
  loadFeaturedCatalogState: async () => ({ listing: mocks.listing }),
}));

import { GET } from '@/app/api/music/home-tracks/stream/route';

const PLAYER = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-dest': 'audio',
  'sec-fetch-mode': 'no-cors',
};

function req(pathname: string | null, headers: Record<string, string> = PLAYER) {
  const url = pathname
    ? `https://solco.example/api/music/home-tracks/stream?p=${encodeURIComponent(pathname)}`
    : 'https://solco.example/api/music/home-tracks/stream';
  return new Request(url, { headers });
}

function okStream(headers: Record<string, string>, contentType = 'audio/mp4') {
  return {
    statusCode: 200,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    headers: new Headers(headers),
    blob: { contentType, size: 3 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token = 'tok_test';
  mocks.user = { id: 'u1' };
  mocks.listing = { audio: [] };
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('GET /api/music/home-tracks/stream: percorsi', () => {
  it('404 se manca il parametro p', async () => {
    expect((await GET(req(null))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 per un percorso non audio', async () => {
    expect((await GET(req('copertina.png'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 per un upload utente (prefisso riservato)', async () => {
    expect((await GET(req('public-uploads/x.mp3'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 senza token', async () => {
    mocks.token = undefined;
    expect((await GET(req('a.mp3'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/home-tracks/stream: accesso', () => {
  it('401 senza sessione, niente lettura dallo store', async () => {
    mocks.user = null;
    const response = await GET(req('a.mp3'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('403 per hotlinking da un altro sito e per l’URL aperto in una scheda', async () => {
    const crossSite = await GET(
      req('a.mp3', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'audio' }),
    );
    expect(crossSite.status).toBe(403);
    const navigation = await GET(
      req('a.mp3', {
        'sec-fetch-site': 'none',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
      }),
    );
    expect(navigation.status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('un browser senza intestazioni Sec-Fetch passa (resta la sessione a decidere)', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    expect((await GET(req('a.mp3', {}))).status).toBe(200);
  });

  it('il limite per account conta gli avvii, non i blocchi del Range', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    await GET(req('a.mp3'));
    await GET(req('a.mp3', { ...PLAYER, range: 'bytes=0-1' }));
    await GET(req('a.mp3', { ...PLAYER, range: 'bytes=1000-' }));
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.featured.stream', 'user:u1');
  });

  it('oltre il limite: la risposta 429 del limite, mai in cache', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      new Response('{"error":"rate_limited"}', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const response = await GET(req('a.mp3'));
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/home-tracks/stream: lettura', () => {
  it('file privato: 200 e trasmette lo stream con content-type e accept-ranges', async () => {
    mocks.get.mockResolvedValue(okStream({ 'content-length': '3' }));
    const response = await GET(req('Rock/mia canzone.m4a'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('3');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(mocks.get).toHaveBeenCalledWith(
      'Rock/mia%20canzone.m4a',
      expect.objectContaining({ access: 'private', token: 'tok_test' }),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('file privato: 206 e inoltra il Range (seek)', async () => {
    mocks.get.mockResolvedValue(
      okStream({ 'content-length': '2', 'content-range': 'bytes 1-2/3' }),
    );
    const response = await GET(req('a.mp3', { ...PLAYER, range: 'bytes=1-2' }));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/3');
    expect(mocks.get).toHaveBeenCalledWith(
      'a.mp3',
      expect.objectContaining({ headers: { range: 'bytes=1-2' } }),
    );
  });

  it('file PUBBLICO (secondo l’elenco condiviso): dal CDN, con lo stesso Range, senza token', async () => {
    mocks.listing = {
      audio: [{ pathname: 'a.mp3', url: 'https://store.public.blob.vercel-storage.com/a.mp3' }],
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([9, 9]), {
          status: 206,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': '2',
            'content-range': 'bytes 0-1/3',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await GET(req('a.mp3', { ...PLAYER, range: 'bytes=0-1' }));
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1/3');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://store.public.blob.vercel-storage.com/a.mp3',
        expect.objectContaining({ headers: { range: 'bytes=0-1' }, redirect: 'error' }),
      );
      expect(mocks.get).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('404 se get() non trova il blob o va in errore', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await GET(req('a.mp3'))).status).toBe(404);
    mocks.get.mockRejectedValue(new Error('rete'));
    expect((await GET(req('a.mp3'))).status).toBe(404);
  });
});
