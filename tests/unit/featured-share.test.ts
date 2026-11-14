// @polsia:user-owned — link diretto «Condividi» dei brani in evidenza: id opaco (HMAC del pathname
// con il segreto del server: deterministico, senza il pathname, spento senza segreto), indice che
// mappa SOLO i brani dichiarati in diritti.json, `shareId` nelle risposte di Home, ricerca globale e
// pagina d'artista solo per i dichiarati, l'API del brano (404 identico per id sconosciuti, non
// dichiarati o malformati; senza sessione niente stream; con sessione il brano da ascoltare;
// intestazioni) e la copertina servita per id (solo quella del brano dichiarato).
// @vitest-environment node
import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  getSession: vi.fn(),
  enforceRateLimit: vi.fn(),
  requireAuth: vi.fn(),
  searchMusic: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@vercel/blob', () => ({
  list: mocks.list,
  get: mocks.get,
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : 'ip:192.0.2.9'),
}));
vi.mock('@/lib/music/music-api.server', () => ({ searchMusic: mocks.searchMusic }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));

import { GET as artistApi } from '@/app/api/music/featured/artists/[slug]/route';
import { GET as shareCover } from '@/app/api/music/featured/tracks/[shareId]/cover/route';
import { GET as shareApi } from '@/app/api/music/featured/tracks/[shareId]/route';
import { GET as homeApi } from '@/app/api/music/home-tracks/route';
import { GET as searchAll } from '@/app/api/music/search-all/route';
import { FeaturedArtistResponseSchema } from '@/lib/contracts/featured-artists';
import { FeaturedShareResponseSchema } from '@/lib/contracts/featured-share';
import { HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import { UnifiedSearchResponseSchema } from '@/lib/contracts/unified-search';
import {
  clearFeaturedSearchCacheForTests,
  getFeaturedShare,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';
import {
  FEATURED_SHARE_ID_PATTERN,
  featuredShareCoverPath,
  featuredShareImagePath,
  featuredShareLabel,
  featuredSharePath,
  featuredShareText,
  isFeaturedShareCoverPath,
  isFeaturedShareId,
} from '@/lib/music/featured-share';
import { featuredShareId, featuredShareSecret } from '@/lib/music/featured-share.server';

const SECRET = 'segreto-di-prova-per-i-link-diretti-0123456789';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

// Dichiarati: uno con la copertina della cartella (privata), uno senza copertina (.ogg). NON
// dichiarati (rip commerciali nello stesso store): uno dello stesso artista e uno di un altro.
const DECLARED = 'Cantautori/Lucio Dalla - Caruso.mp3';
const DECLARED_NO_COVER = 'Lucio Dalla - Anna e Marco.ogg';
const UNDECLARED = 'Download/Lucio Dalla - Caruso (Remastered).mp3';
const UNDECLARED_OTHER = 'Download/Artista Commerciale - Hit.mp3';
const FOLDER_COVER = 'Cantautori/cover.jpg';
const STORE = [
  blob(DECLARED, '2026-10-03T00:00:00.000Z'),
  blob(DECLARED_NO_COVER, '2026-10-02T00:00:00.000Z'),
  blob(FOLDER_COVER, '2026-10-01T00:00:00.000Z'),
  blob(UNDECLARED, '2026-10-05T00:00:00.000Z'),
  blob(UNDECLARED_OTHER, '2026-10-06T00:00:00.000Z'),
  blob('diritti.json', '2026-10-07T00:00:00.000Z', 200),
];
const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [DECLARED, DECLARED_NO_COVER].map((file) => ({
    file,
    licenza: 'propria',
    titolare: 'Solco',
  })),
});

let JPEG: Uint8Array;

beforeAll(async () => {
  JPEG = new Uint8Array(
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#e11d48' } })
      .jpeg()
      .toBuffer(),
  );
});

function stored(data: Uint8Array | string, pathname: string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return {
    statusCode: 200,
    stream: new Response(bytes).body,
    headers: new Headers({ 'content-length': String(bytes.byteLength) }),
    blob: { pathname, size: bytes.byteLength },
  };
}

function serveStore() {
  mocks.list.mockImplementation(async () => ({ blobs: STORE, hasMore: false }));
  mocks.get.mockImplementation(async (target: string) => {
    if (String(target).includes('cover.jpg')) return stored(JPEG, FOLDER_COVER);
    return stored(MANIFEST, 'diritti.json');
  });
}

const DECLARED_ID = featuredShareId(DECLARED, SECRET);
const DECLARED_NO_COVER_ID = featuredShareId(DECLARED_NO_COVER, SECRET);
const UNDECLARED_ID = featuredShareId(UNDECLARED, SECRET);
const UNKNOWN_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

function shareRequest(shareId: string, path = '') {
  return [
    new Request(`https://solco.example/api/music/featured/tracks/${shareId}${path}`, {
      headers: { 'x-real-ip': '192.0.2.9' },
    }),
    { params: Promise.resolve({ shareId }) },
  ] as const;
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  mocks.token = 'tok_test';
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.requireAuth.mockReset().mockResolvedValue({ id: 'user-1' });
  mocks.searchMusic.mockReset().mockImplementation(async (source: string) => ({
    source,
    outcome: 'no_results',
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
    sourceStatus: { id: source },
  }));
  mocks.listStations.mockReset().mockResolvedValue({ outcome: 'no_results', stations: [] });
  mocks.searchPodcasts.mockReset().mockResolvedValue({ outcome: 'no_results', podcasts: [] });
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  serveStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('id opaco (featured-share.server)', () => {
  it('deterministico: base64url(HMAC-SHA256(segreto, "featured-share:v1:" + pathname)), 22 caratteri', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`featured-share:v1:${DECLARED}`)
      .digest('base64url')
      .slice(0, 22);
    expect(featuredShareId(DECLARED, SECRET)).toBe(expected);
    expect(featuredShareId(DECLARED, SECRET)).toBe(featuredShareId(DECLARED, SECRET));
    expect(DECLARED_ID).toMatch(FEATURED_SHARE_ID_PATTERN);
    expect(isFeaturedShareId(DECLARED_ID)).toBe(true);
    // Brani diversi, id diversi; segreto diverso, id diverso (nessuno lo calcola senza segreto).
    expect(DECLARED_ID).not.toBe(UNDECLARED_ID);
    expect(featuredShareId(DECLARED, 'altro-segreto')).not.toBe(DECLARED_ID);
  });

  it('il link non rivela il pathname: niente cartelle, nomi o estensione', () => {
    const link = featuredSharePath(DECLARED_ID);
    expect(link).toBe(`/evidenza/${DECLARED_ID}`);
    for (const piece of ['Cantautori', 'Lucio', 'Caruso', '.mp3', '%2F']) {
      expect(link).not.toContain(piece);
      expect(featuredShareImagePath(DECLARED_ID)).not.toContain(piece);
      expect(featuredShareCoverPath(DECLARED_ID)).not.toContain(piece);
    }
  });

  it('senza segreto la condivisione è spenta', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    expect(featuredShareSecret()).toBeNull();
    vi.stubEnv('BETTER_AUTH_SECRET', '   ');
    expect(featuredShareSecret()).toBeNull();
    vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
    expect(featuredShareSecret()).toBe(SECRET);
  });

  it('forma dell’id e della copertina, testi senza indirizzi web', () => {
    for (const bad of ['', 'corto', `${DECLARED_ID}x`, 'AAAAAAAAAAAAAAAAAAAA/A', 'A'.repeat(21)]) {
      expect(isFeaturedShareId(bad)).toBe(false);
    }
    expect(isFeaturedShareCoverPath(featuredShareCoverPath(DECLARED_ID))).toBe(true);
    expect(isFeaturedShareCoverPath('/api/music/home-tracks/cover?p=x.jpg')).toBe(false);
    expect(featuredShareText('Caruso', 'Lucio Dalla')).toBe(
      'Ascolta «Caruso» di Lucio Dalla su Solco.',
    );
    expect(featuredShareText('Caruso', null)).toBe('Ascolta «Caruso» su Solco.');
    expect(featuredShareText('Caruso https://evil.example/x', 'www.spam.com Lucio')).toBe(
      'Ascolta «Caruso» di Lucio su Solco.',
    );
    expect(featuredShareLabel('Caruso', 'Lucio Dalla')).toBe('Caruso · Lucio Dalla');
    expect(featuredShareLabel('Caruso', null)).toBe('Caruso');
  });
});

describe('indice: SOLO i brani dichiarati hanno un link', () => {
  it('shareId → brano dichiarato; un brano non dichiarato non ha id né link', async () => {
    const found = await getFeaturedShare(DECLARED_ID);
    expect(found.outcome).toBe('found');
    expect(found.outcome === 'found' && found.track.id).toBe(DECLARED);
    expect(found.outcome === 'found' && found.track.shareId).toBe(DECLARED_ID);
    expect((await getFeaturedShare(DECLARED_NO_COVER_ID)).outcome).toBe('found');
    // L'id che avrebbe il brano non dichiarato non porta a nulla, come un id inventato.
    expect(await getFeaturedShare(UNDECLARED_ID)).toEqual({ outcome: 'not_found' });
    expect(await getFeaturedShare(UNKNOWN_ID)).toEqual({ outcome: 'not_found' });
  });

  it('id malformato: not_found senza toccare lo store', async () => {
    expect(await getFeaturedShare('../../diritti.json')).toEqual({ outcome: 'not_found' });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('senza segreto: nessun id nell’indice e nessun link trovato', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    const { tracks } = await searchFeaturedTracks('lucio dalla');
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((track) => track.shareId === undefined)).toBe(true);
    expect(await getFeaturedShare(DECLARED_ID)).toEqual({ outcome: 'not_found' });
  });

  it('Blob non configurato: unavailable', async () => {
    mocks.token = undefined;
    expect(await getFeaturedShare(DECLARED_ID)).toEqual({ outcome: 'unavailable' });
  });
});

describe('shareId nelle risposte: solo per i dichiarati', () => {
  it('Home: shareId per i dichiarati, null per gli altri (che restano in Home)', async () => {
    const response = await homeApi(new Request('https://solco.example/api/music/home-tracks'));
    const body = HomeTracksResponseSchema.parse(await response.json());
    const byId = Object.fromEntries(body.items.map((item) => [item.id, item.shareId]));
    expect(byId).toEqual({
      [DECLARED]: DECLARED_ID,
      [DECLARED_NO_COVER]: DECLARED_NO_COVER_ID,
      [UNDECLARED]: null,
      [UNDECLARED_OTHER]: null,
    });
    for (const section of body.sections) {
      for (const item of section.items) expect(item.shareId).toBe(byId[item.id]);
    }
  });

  it('Home senza segreto: nessun link', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    const response = await homeApi(new Request('https://solco.example/api/music/home-tracks'));
    const body = HomeTracksResponseSchema.parse(await response.json());
    expect(body.items.length).toBe(4);
    expect(body.items.every((item) => item.shareId === null)).toBe(true);
  });

  it('ricerca globale: i brani in evidenza (solo dichiarati) portano shareId', async () => {
    const url = new URL('https://solco.example/api/music/search-all');
    url.searchParams.set('q', 'caruso');
    url.searchParams.set('featured', '1');
    const result = UnifiedSearchResponseSchema.parse(
      await (await searchAll(new Request(url))).json(),
    );
    const featured = result.results.flatMap((item) =>
      item.kind === 'featured' ? [item.track] : [],
    );
    expect(featured.map((track) => [track.id, track.shareId])).toEqual([[DECLARED, DECLARED_ID]]);
    expect(JSON.stringify(result)).not.toContain('Remastered');
  });

  it('pagina d’artista: ogni brano (dichiarato) porta il suo shareId', async () => {
    const response = await artistApi(
      new Request('https://solco.example/api/music/featured/artists/lucio-dalla'),
      { params: Promise.resolve({ slug: 'lucio-dalla' }) },
    );
    const body = FeaturedArtistResponseSchema.parse(await response.json());
    expect(body.tracks.map((track) => [track.id, track.shareId])).toEqual([
      [DECLARED, DECLARED_ID],
      [DECLARED_NO_COVER, DECLARED_NO_COVER_ID],
    ]);
  });
});

describe('GET /api/music/featured/tracks/<shareId>', () => {
  async function snapshot(response: Response) {
    return {
      status: response.status,
      body: await response.json(),
      cache: response.headers.get('cache-control'),
      vary: response.headers.get('vary'),
    };
  }

  it('id sconosciuto, non dichiarato o malformato: la STESSA risposta 404', async () => {
    const unknown = await snapshot(await shareApi(...shareRequest(UNKNOWN_ID)));
    const undeclared = await snapshot(await shareApi(...shareRequest(UNDECLARED_ID)));
    const malformed = await snapshot(await shareApi(...shareRequest('non-valido')));
    expect(unknown).toEqual({
      status: 404,
      body: { error: 'not_found' },
      cache: 'private, no-store',
      vary: 'Cookie',
    });
    expect(undeclared).toEqual(unknown);
    expect(malformed).toEqual(unknown);
  });

  it('senza sessione: solo metadati, mai lo stream né il pathname', async () => {
    const response = await shareApi(...shareRequest(DECLARED_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const raw = await response.text();
    const body = FeaturedShareResponseSchema.parse(JSON.parse(raw));
    expect(body).toEqual({
      track: {
        shareId: DECLARED_ID,
        title: 'Caruso',
        artist: 'Lucio Dalla',
        artistSlug: 'lucio-dalla',
        coverPath: featuredShareCoverPath(DECLARED_ID),
      },
      homeTrack: null,
    });
    for (const leak of ['Cantautori', '.mp3', 'stream', 'cover.jpg', 'home-tracks']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('senza copertina: coverPath null', async () => {
    const body = FeaturedShareResponseSchema.parse(
      await (await shareApi(...shareRequest(DECLARED_NO_COVER_ID))).json(),
    );
    expect(body.track.coverPath).toBeNull();
    expect(body.track.title).toBe('Anna e Marco');
  });

  it('con una sessione: anche il brano da riprodurre (streamUrl)', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    const response = await shareApi(...shareRequest(DECLARED_ID));
    const body = FeaturedShareResponseSchema.parse(await response.json());
    expect(body.homeTrack?.id).toBe(DECLARED);
    expect(body.homeTrack?.streamUrl).toBe(
      `/api/music/home-tracks/stream?p=${encodeURIComponent(DECLARED)}`,
    );
    expect(body.homeTrack?.shareId).toBe(DECLARED_ID);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', 'user:user-1');
  });

  it('sessione non verificabile: come senza sessione (niente stream)', async () => {
    mocks.getSession.mockRejectedValue(new Error('db giù'));
    const body = FeaturedShareResponseSchema.parse(
      await (await shareApi(...shareRequest(DECLARED_ID))).json(),
    );
    expect(body.homeTrack).toBeNull();
  });

  it('limite raggiunto: 429 mai in cache; Blob non leggibile: 503', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );
    const limited = await shareApi(...shareRequest(DECLARED_ID));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', 'ip:192.0.2.9');

    mocks.token = undefined;
    const unavailable = await shareApi(...shareRequest(DECLARED_ID));
    expect(unavailable.status).toBe(503);
  });

  it('id malformato: nessun limite consumato, nessuna lettura', async () => {
    await shareApi(...shareRequest('x'));
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/featured/tracks/<shareId>/cover', () => {
  it('la copertina del brano dichiarato (JPEG), letta dallo store per id', async () => {
    const response = await shareCover(...shareRequest(DECLARED_ID, '/cover'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    // Nessuna finestra «stale»: una revoca la toglie entro ~1 giorno (CDN) + ~1 ora (browser).
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(meta.format).toBe('jpeg');
    // L'unica immagine letta è la copertina della cartella del brano dichiarato.
    const reads = mocks.get.mock.calls.map(([target]) => String(target));
    expect(reads.filter((target) => target.includes('.jpg'))).toEqual([FOLDER_COVER]);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.cover', 'ip:192.0.2.9');
  });

  it('id sconosciuto, non dichiarato o malformato, brano senza copertina: 404', async () => {
    for (const id of [UNKNOWN_ID, UNDECLARED_ID, 'non-valido', DECLARED_NO_COVER_ID]) {
      const response = await shareCover(...shareRequest(id, '/cover'));
      expect(response.status).toBe(404);
    }
    expect(mocks.get.mock.calls.some(([target]) => String(target).includes('.jpg'))).toBe(false);
  });

  it('lettura della copertina fallita: 404 mai in cache', async () => {
    mocks.get.mockImplementation(async (target: string) => {
      if (String(target).includes('cover.jpg')) throw new Error('rete');
      return stored(MANIFEST, 'diritti.json');
    });
    const response = await shareCover(...shareRequest(DECLARED_ID, '/cover'));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
