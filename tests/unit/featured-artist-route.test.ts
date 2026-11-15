// @polsia:user-owned — pagina d'artista dei brani in evidenza, lato server: l'indice raggruppa SOLO
// i brani dichiarati in diritti.json (un brano NON dichiarato dello stesso artista non compare mai,
// né come principale né come ospite), con la stessa scansione dello store della ricerca; la route
// GET /api/music/featured/artists/<slug> chiede la sessione, valida lo slug prima del limite, dà
// 404 senza brani dichiarati, 503 se lo store non risponde, e i brani con gli stessi dati della
// Home (riproduzione identica), mai in cache.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  requireAuth: vi.fn(),
  enforceRateLimit: vi.fn(),
  hasPremiumAccess: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/premium-access.server', () => ({
  hasPremiumAccess: mocks.hasPremiumAccess,
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));

import { GET } from '@/app/api/music/featured/artists/[slug]/route';
import { FeaturedArtistResponseSchema } from '@/lib/contracts/featured-artists';
import {
  clearFeaturedSearchCacheForTests,
  getFeaturedArtist,
  loadFeaturedArtistSlugs,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';
import { listHomeTrackSections } from '@/lib/music/home-tracks.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

// Dichiarati: due brani di Lucio Dalla (uno con Mina ospite) e uno di Mina. NON dichiarati (rip
// commerciali nello stesso store): un altro Lucio Dalla, un brano con Lucio Dalla ospite e un
// artista che ha SOLO brani non dichiarati.
const DECLARED_1 = 'Cantautori/Lucio Dalla - Caruso.mp3';
const DECLARED_2 = 'Cantautori/Lucio Dalla feat. Mina - Duetto.mp3';
const DECLARED_3 = 'Mina - Grande grande grande.mp3';
const UNDECLARED_SAME_ARTIST = 'Download/Lucio Dalla - Attenti al lupo.mp3';
const UNDECLARED_GUEST = 'Download/Altro feat. Lucio Dalla - Remix.mp3';
const UNDECLARED_ONLY = 'Download/Artista Commerciale - Hit.mp3';

const STORE = [
  blob(DECLARED_1, '2026-10-03T00:00:00.000Z'),
  blob(DECLARED_2, '2026-10-02T00:00:00.000Z'),
  blob(DECLARED_3, '2026-10-01T00:00:00.000Z'),
  blob('Cantautori/cover.jpg', '2026-10-01T00:00:00.000Z'),
  blob(UNDECLARED_SAME_ARTIST, '2026-10-05T00:00:00.000Z'),
  blob(UNDECLARED_GUEST, '2026-10-06T00:00:00.000Z'),
  blob(UNDECLARED_ONLY, '2026-10-07T00:00:00.000Z'),
  blob('diritti.json', '2026-10-08T00:00:00.000Z', 200),
];

function manifest(files: string[]) {
  return JSON.stringify({
    versione: 1,
    brani: files.map((file) => ({ file, licenza: 'propria', titolare: 'Solco' })),
  });
}

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

function serveStore(blobs = STORE, rights = manifest([DECLARED_1, DECLARED_2, DECLARED_3])): void {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(rights));
}

function request(slug: string) {
  return GET(new Request(`https://solco.example/api/music/featured/artists/${slug}`), {
    params: Promise.resolve({ slug }),
  });
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.token = 'tok_test';
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockReset();
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.hasPremiumAccess.mockReset();
  mocks.hasPremiumAccess.mockResolvedValue(false);
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('indice degli artisti: solo brani dichiarati', () => {
  it('la pagina di un artista elenca SOLO i suoi brani dichiarati (principale o ospite)', async () => {
    serveStore();
    const dalla = await getFeaturedArtist('lucio-dalla');
    expect(dalla.outcome).toBe('found');
    if (dalla.outcome !== 'found') return;
    expect(dalla.artist).toEqual({ name: 'Lucio Dalla', slug: 'lucio-dalla' });
    expect(dalla.tracks.map((track) => track.id)).toEqual([DECLARED_1, DECLARED_2]);

    const mina = await getFeaturedArtist('mina');
    expect(mina.outcome === 'found' && mina.tracks.map((track) => track.id)).toEqual([
      DECLARED_2,
      DECLARED_3,
    ]);
  });

  it('un brano NON dichiarato dello stesso artista non compare mai, nemmeno come ospite', async () => {
    serveStore();
    const ids = [];
    for (const slug of ['lucio-dalla', 'mina', 'altro', 'artista-commerciale']) {
      const result = await getFeaturedArtist(slug);
      if (result.outcome === 'found') ids.push(...result.tracks.map((track) => track.id));
    }
    expect(ids).not.toContain(UNDECLARED_SAME_ARTIST);
    expect(ids).not.toContain(UNDECLARED_GUEST);
    expect(ids).not.toContain(UNDECLARED_ONLY);
    // La Home, invece, li mostra tutti (non cambia).
    const home = (await listHomeTrackSections()).items.map((item) => item.id);
    expect(home).toEqual(expect.arrayContaining([UNDECLARED_SAME_ARTIST, UNDECLARED_ONLY]));
  });

  it('un artista con soli brani non dichiarati non ha pagina (not_found) né slug', async () => {
    serveStore();
    expect(await getFeaturedArtist('artista-commerciale')).toEqual({ outcome: 'not_found' });
    expect(await getFeaturedArtist('altro')).toEqual({ outcome: 'not_found' });
    const slugs = await loadFeaturedArtistSlugs();
    expect(slugs ? [...slugs].sort() : null).toEqual(['lucio-dalla', 'mina']);
  });

  it('i brani della pagina portano artistSlug del loro artista principale', async () => {
    serveStore();
    const mina = await getFeaturedArtist('mina');
    expect(mina.outcome === 'found' && mina.tracks.map((track) => track.artistSlug)).toEqual([
      'lucio-dalla',
      'mina',
    ]);
  });

  it('manifest assente o revocato: nessuna pagina; Blob non configurato: unavailable', async () => {
    serveStore(STORE.filter((item) => item.pathname !== 'diritti.json'));
    expect(await getFeaturedArtist('lucio-dalla')).toEqual({ outcome: 'not_found' });
    expect(await loadFeaturedArtistSlugs()).toEqual(new Set());

    clearFeaturedSearchCacheForTests();
    mocks.token = undefined;
    expect(await getFeaturedArtist('lucio-dalla')).toEqual({ outcome: 'unavailable' });
    expect(await loadFeaturedArtistSlugs()).toBeNull();
  });

  it('store non leggibile: unavailable (non "nessun brano")', async () => {
    mocks.list.mockRejectedValue(new Error('down'));
    expect(await getFeaturedArtist('lucio-dalla')).toEqual({ outcome: 'unavailable' });
    expect(await loadFeaturedArtistSlugs()).toBeNull();
  });

  it('ricerca, pagina d’artista e slug della Home condividono UNA sola scansione dello store', async () => {
    serveStore();
    await Promise.all([
      searchFeaturedTracks('caruso'),
      getFeaturedArtist('lucio-dalla'),
      loadFeaturedArtistSlugs(),
    ]);
    await getFeaturedArtist('mina');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('slug non valido: not_found senza leggere lo store', async () => {
    serveStore();
    expect(await getFeaturedArtist('Lucio-Dalla')).toEqual({ outcome: 'not_found' });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/featured/artists/<slug>', () => {
  it('senza sessione: 401, nessun limite consumato e nessuna lettura dello store', async () => {
    serveStore();
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await request('lucio-dalla');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('sessione non verificabile (errore): 503, non 401', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('db down'));
    expect((await request('lucio-dalla')).status).toBe(503);
  });

  it.each(['Lucio-Dalla', 'lucio--dalla', '-lucio', 'lucio%20dalla', '..', 'a'.repeat(81)])(
    'slug non valido %s: 400 prima del limite e dello store',
    async (slug) => {
      serveStore();
      const response = await request(slug);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ errors: { slug: 'Artista non valido.' } });
      expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );

  it('200: artista e soli brani dichiarati, stessi dati della Home, mai in cache', async () => {
    serveStore();
    const response = await request('lucio-dalla');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = FeaturedArtistResponseSchema.parse(await response.json());
    expect(Object.keys(body).sort()).toEqual(['artist', 'total', 'tracks']);
    expect(body.total).toBe(2);
    expect(body.artist).toEqual({ name: 'Lucio Dalla', slug: 'lucio-dalla' });
    expect(body.tracks.map((track) => track.id)).toEqual([DECLARED_1, DECLARED_2]);

    const home = (await listHomeTrackSections()).sections.flatMap((section) => section.items);
    for (const track of body.tracks) {
      const inHome = home.find((item) => item.id === track.id);
      // Più il permesso della copia offline (licenza propria: consentita).
      expect(track).toEqual({ ...inHome, artistSlug: 'lucio-dalla', offline: true });
    }
    expect(body.tracks[0]).toMatchObject({
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(DECLARED_1)}`,
      artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent('Cantautori/cover.jpg')}`,
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.search', 'user:user-1');
  });

  it('404 per un artista senza brani dichiarati (anche se ha brani nello store)', async () => {
    serveStore();
    const response = await request('artista-commerciale');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('503 quando lo store non è configurato o non risponde', async () => {
    mocks.token = undefined;
    const response = await request('lucio-dalla');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });

  it('limite raggiunto: la risposta 429 del limite, mai in cache', async () => {
    serveStore();
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const response = await request('lucio-dalla');
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('piano della pagina d’artista: Premium tutti, Free i 30 più recenti', () => {
  function serveManyByArtist(count: number) {
    const files = Array.from({ length: count }, (_, index) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      const month = index < 28 ? '08' : '09';
      return blob(`Prolifico - Brano ${index + 1}.mp3`, `2026-${month}-${day}T00:00:00.000Z`);
    });
    serveStore(
      [...files, blob('diritti.json', '2026-10-09T00:00:00.000Z', 200)],
      manifest(files.map((file) => file.pathname)),
    );
  }

  it('Free: 30 brani e il totale; Premium: tutti', async () => {
    serveManyByArtist(40);
    const free = FeaturedArtistResponseSchema.parse(await (await request('prolifico')).json());
    expect(free.tracks).toHaveLength(30);
    expect(free.total).toBe(40);
    const all = await getFeaturedArtist('prolifico');
    const allIds = all.outcome === 'found' ? all.tracks.map((track) => track.id) : [];
    expect(free.tracks.map((track) => track.id)).toEqual(allIds.slice(0, 30));

    mocks.hasPremiumAccess.mockResolvedValue(true);
    const premium = FeaturedArtistResponseSchema.parse(await (await request('prolifico')).json());
    expect(premium.tracks).toHaveLength(40);
    expect(premium.total).toBe(40);
  });

  it('fino a 30 brani: nessun controllo del Premium', async () => {
    serveStore();
    await request('lucio-dalla');
    expect(mocks.hasPremiumAccess).not.toHaveBeenCalled();
  });
});
