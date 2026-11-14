// @polsia:user-owned — GET /api/music/home-tracks con il link all'artista: `artistSlug` SOLO per gli
// artisti con almeno un brano dichiarato in diritti.json (nessun link a una pagina vuota); per il
// resto la Home è quella di sempre (stessi brani, anche non dichiarati, stesse sezioni e ordine).
// Senza manifest o con l'indice lento nessun link, e la Home non aspetta oltre il margine.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: vi.fn(async () => null),
  getRateLimitIdentity: vi.fn(() => 'ip:192.0.2.9'),
}));

import { GET } from '@/app/api/music/home-tracks/route';
import { HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';
import { listHomeTrackSections } from '@/lib/music/home-tracks.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

const DECLARED = 'Cantautori/Lucio Dalla - Caruso.mp3';
const SAME_ARTIST_UNDECLARED = 'Download/LUCIO DALLA - Attenti al lupo.mp3';
const UNDECLARED_ARTIST = 'Download/Artista Commerciale - Hit.mp3';
const GUEST_ONLY = 'Download/Mina - Solo lei.mp3';
const NO_ARTIST = 'Strumentale.mp3';
const STORE = [
  blob(DECLARED, '2026-10-02T00:00:00.000Z'),
  blob('Cantautori/Altra feat. Mina - Duetto.mp3', '2026-10-01T00:00:00.000Z'),
  blob(SAME_ARTIST_UNDECLARED, '2026-10-03T00:00:00.000Z'),
  blob(UNDECLARED_ARTIST, '2026-10-04T00:00:00.000Z'),
  blob(GUEST_ONLY, '2026-10-05T00:00:00.000Z'),
  blob(NO_ARTIST, '2026-10-06T00:00:00.000Z'),
  blob('diritti.json', '2026-10-07T00:00:00.000Z', 200),
];
const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [DECLARED, 'Cantautori/Altra feat. Mina - Duetto.mp3'].map((file) => ({
    file,
    licenza: 'propria',
    titolare: 'Solco',
  })),
});

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

function serveStore(blobs = STORE) {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(MANIFEST));
}

async function home() {
  const response = await GET(new Request('https://solco.example/api/music/home-tracks'));
  return { response, body: HomeTracksResponseSchema.parse(await response.json()) };
}

function slugsById(items: Array<{ id: string; artistSlug?: string | null }>) {
  return Object.fromEntries(items.map((item) => [item.id, item.artistSlug]));
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.token = 'tok_test';
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /api/music/home-tracks: link all’artista', () => {
  it('artistSlug solo per gli artisti dichiarati; la Home resta quella di sempre', async () => {
    serveStore();
    const { response, body } = await home();
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
    expect(slugsById(body.items)).toEqual({
      [DECLARED]: 'lucio-dalla',
      // Stesso artista (altra grafia), brano non dichiarato: il link porta alla pagina che elenca
      // solo i brani dichiarati, quindi non è mai vuota.
      [SAME_ARTIST_UNDECLARED]: 'lucio-dalla',
      [UNDECLARED_ARTIST]: null,
      // Mina è solo OSPITE di un brano dichiarato: il link della Home segue l'artista principale.
      [GUEST_ONLY]: 'mina',
      'Cantautori/Altra feat. Mina - Duetto.mp3': 'altra',
      [NO_ARTIST]: null,
    });
    for (const section of body.sections) {
      for (const item of section.items) {
        expect(item.artistSlug).toBe(slugsById(body.items)[item.id]);
      }
    }

    // Tolto artistSlug, identica all'elenco della Home di sempre (brani, sezioni, ordine).
    const plain = await listHomeTrackSections();
    const strip = <T extends { artistSlug?: string | null }>({ artistSlug: _, ...rest }: T) => rest;
    expect(body.items.map(strip)).toEqual(plain.items);
    expect(body.sections.map((s) => ({ ...s, items: s.items.map(strip) }))).toEqual(plain.sections);
  });

  it('senza diritti.json nessun link (nessun artista ha brani dichiarati)', async () => {
    serveStore(STORE.filter((item) => item.pathname !== 'diritti.json'));
    const { body } = await home();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.artistSlug === null)).toBe(true);
  });

  it('indice in cache: una sola lettura del manifest anche con più richieste della Home', async () => {
    serveStore();
    await home();
    await home();
    // 2 elenchi della Home + 1 solo per l'indice (poi in cache); il manifest letto una volta.
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('indice lento: la Home risponde entro il margine, senza link', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.list.mockImplementation(async () => ({ blobs: STORE, hasMore: false }));
    // Il manifest non arriva mai: l'indice resta in costruzione.
    mocks.get.mockImplementation(() => new Promise(() => undefined));
    let settled = false;
    const pending = home().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    const { body } = await pending;
    expect(body.items.length).toBe(6);
    expect(body.items.every((item) => item.artistSlug === null)).toBe(true);
  });

  it('Blob non configurato: Home vuota come sempre', async () => {
    mocks.token = undefined;
    const { body } = await home();
    expect(body).toEqual({ items: [], sections: [] });
  });
});
