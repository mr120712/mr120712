// @polsia:user-owned — GET /api/music/home-tracks/version ({ version, updatedAt }, cache CDN 30 s +
// 60 s stale, nessun rate-limit) e GET /api/music/home-tracks per versione: `?v=` attuale con
// contenuto definitivo → cache CDN lunga e niente rate-limit; senza `v` → come sempre (60 s);
// `v` superata o inventata → elenco attuale con la sua versione e cache di pochi secondi (niente
// redirect); contenuto non definitivo (link non pronti, elenco degradato) → senza `version`.
// Più: la versione non usa lo stale-while-revalidate dell'istanza e la CDN la tiene solo per il
// tempo che resta all'elenco (novità entro ~60 s, non ~2 minuti); nessuna versione da un'istanza
// senza elenco buono (503 senza cache); `?v=` con parametri in più resta soggetto al rate-limit;
// diritti.json pubblico → niente cache lunga; `listedAt` per non tornare indietro.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  enforceRateLimit: vi.fn(async (): Promise<Response | null> => null),
}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: vi.fn(() => 'ip:192.0.2.9'),
}));

import { GET as homeGET } from '@/app/api/music/home-tracks/route';
import { GET as versionGET } from '@/app/api/music/home-tracks/version/route';
import { HomeTracksResponseSchema, HomeTracksVersionSchema } from '@/lib/contracts/home-tracks';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const PUBLIC = 'https://store.public.blob.vercel-storage.com';
const DECLARED = 'Cantautori/Lucio Dalla - Caruso.mp3';
const LONG = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
const LEGACY = 'public, s-maxage=60, stale-while-revalidate=300';
const SHORT = 'public, max-age=0, s-maxage=5';
const NEW_TRACK = 'Novità/Mina - Nuova.mp3';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

const STORE = [
  blob(DECLARED, '2026-10-02T00:00:00.000Z'),
  blob('Download/Artista - Hit.mp3', '2026-10-03T00:00:00.000Z'),
  blob('diritti.json', '2026-10-04T00:00:00.000Z', 200),
];
const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [{ file: DECLARED, licenza: 'propria', titolare: 'Solco' }],
});

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

function serveStore(blobs = STORE, manifest = MANIFEST) {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(manifest));
}

async function version() {
  const response = await versionGET();
  return { response, body: HomeTracksVersionSchema.parse(await response.json()) };
}

async function home(query = '') {
  const response = await homeGET(new Request(`https://solco.test/api/music/home-tracks${query}`));
  return { response, body: HomeTracksResponseSchema.parse(await response.json()) };
}

const T0 = new Date('2026-11-15T10:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.enforceRateLimit.mockReset();
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.token = 'tok_test';
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /api/music/home-tracks/version', () => {
  it('versione e data, cache CDN 30 s + 60 s stale, nessun rate-limit né dati utente', async () => {
    serveStore();
    const { response, body } = await version();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
    );
    expect(Object.keys(body).sort()).toEqual(['listedAt', 'updatedAt', 'version']);
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
    expect(body.updatedAt).toBe(new Date(T0).toISOString());
    expect(body.listedAt).toBe(new Date(T0).toISOString());
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('la CDN tiene la versione solo per il tempo che resta all’elenco dell’istanza', async () => {
    serveStore();
    await version();
    vi.setSystemTime(T0 + 20_500);
    const { response } = await version();
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=9, stale-while-revalidate=60',
    );
    vi.setSystemTime(T0 + 29_900);
    expect((await version()).response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=1, stale-while-revalidate=60',
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('scaduta la finestra NON risponde con l’elenco vecchio: un brano caricato compare entro ~60 s', async () => {
    serveStore();
    const first = (await version()).body;
    // Caricato subito dopo l'elenco: a 59,95 s prima rispondeva ancora la versione vecchia
    // (stale-while-revalidate dell'istanza) e la CDN la teneva altri 30 s.
    serveStore([...STORE, blob(NEW_TRACK, '2026-11-15T10:00:00.100Z')]);
    vi.setSystemTime(T0 + 30_000);
    const next = await version();
    expect(next.body.version).not.toBe(first.version);
    expect(next.body.listedAt).toBe(new Date(T0 + 30_000).toISOString());
    expect(next.response.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=30, stale-while-revalidate=60',
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('`listedAt` va avanti a ogni elenco riuscito, anche a versione invariata', async () => {
    serveStore();
    const first = (await version()).body;
    vi.setSystemTime(T0 + 45_000);
    const same = (await version()).body;
    expect(same.version).toBe(first.version);
    expect(same.updatedAt).toBe(first.updatedAt);
    expect(same.listedAt).toBe(new Date(T0 + 45_000).toISOString());
  });

  it('istanza appena avviata con lo store in errore: 503 senza cache, mai una versione in CDN', async () => {
    mocks.list.mockRejectedValue(new Error('blob down'));
    const response = await versionGET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // Lo store torna: versione normale, in cache.
    serveStore();
    vi.setSystemTime(T0 + 31_000);
    const { response: recovered } = await version();
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('cache-control')).toContain('s-maxage=30');
  });

  it('store in errore dopo un elenco buono: resta l’ultima versione buona (con il suo listedAt)', async () => {
    serveStore();
    const good = (await version()).body;
    mocks.list.mockRejectedValue(new Error('blob down'));
    vi.setSystemTime(T0 + 31_000);
    const { response, body } = await version();
    expect(response.status).toBe(200);
    expect(body.version).toBe(good.version);
    expect(body.listedAt).toBe(good.listedAt);
  });

  it('cambia quando cambia lo store (dopo la finestra), uguale finché non cambia', async () => {
    serveStore();
    const first = (await version()).body.version;
    vi.setSystemTime(T0 + 20_000);
    expect((await version()).body.version).toBe(first);
    serveStore([...STORE, blob('Novità/Mina - Nuova.mp3')]);
    vi.setSystemTime(T0 + 91_000);
    expect((await version()).body.version).not.toBe(first);
  });

  it('Blob non configurato: risponde comunque con una versione valida', async () => {
    mocks.token = undefined;
    const { response, body } = await version();
    expect(response.status).toBe(200);
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('GET /api/music/home-tracks?v=<versione>', () => {
  it('versione attuale: cache CDN lunga, `version` nel corpo, niente rate-limit né elenco in più', async () => {
    serveStore();
    const current = (await version()).body.version;
    const { response, body } = await home(`?v=${current}`);
    expect(response.headers.get('cache-control')).toBe(LONG);
    expect(body.version).toBe(current);
    expect(body.listedAt).toBe(new Date(T0).toISOString());
    expect(body.items.map((item) => item.id)).toEqual(['Download/Artista - Hit.mp3', DECLARED]);
    expect(body.items.find((item) => item.id === DECLARED)?.artistSlug).toBe('lucio-dalla');
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('senza `v`: come sempre (cache 60 s) e con il rate-limit delle letture di catalogo', async () => {
    serveStore();
    const { response, body } = await home();
    expect(response.headers.get('cache-control')).toBe(LEGACY);
    expect(body.items).toHaveLength(2);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', 'ip:192.0.2.9');
  });

  it('versione superata o inventata: elenco ATTUALE con la sua versione, cache di pochi secondi, nessun redirect', async () => {
    serveStore();
    const current = (await version()).body.version;
    for (const stale of ['0000000000000000', 'non-una-versione']) {
      const { response, body } = await home(`?v=${stale}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe(SHORT);
      expect(body.version).toBe(current);
      expect(body.items).toHaveLength(2);
    }
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('versione attuale con parametri in più (aggira la CDN): rate-limit e cache breve', async () => {
    serveStore();
    const current = (await version()).body.version;
    for (let index = 0; index < 3; index += 1) {
      const { response, body } = await home(`?v=${current}&t=${index}`);
      expect(response.headers.get('cache-control')).toBe(SHORT);
      expect(body.version).toBe(current);
    }
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(3);
    for (const query of [`?t=1&v=${current}`, `?v=${current}&v=${current}`]) {
      expect((await home(query)).response.headers.get('cache-control')).toBe(SHORT);
    }
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(5);
    // La query esatta resta senza rate-limit e in cache lunga.
    expect((await home(`?v=${current}`)).response.headers.get('cache-control')).toBe(LONG);
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(5);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('parametri in più oltre il limite: 429', async () => {
    serveStore();
    const current = (await version()).body.version;
    mocks.enforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const response = await homeGET(
      new Request(`https://solco.test/api/music/home-tracks?v=${current}&t=9`),
    );
    expect(response.status).toBe(429);
  });

  it('diritti.json PUBBLICO: link che possono cambiare a versione invariata, mai in cache lunga', async () => {
    const manifestUrl = `${PUBLIC}/diritti.json`;
    const publicManifest = {
      ...blob('diritti.json', '2026-10-04T00:00:00.000Z', 200),
      url: manifestUrl,
      downloadUrl: manifestUrl,
    };
    const store = [...STORE.filter((item) => item.pathname !== 'diritti.json'), publicManifest];
    serveStore(store);
    // Il CDN di Vercel Blob serve ancora la copia precedente; dopo l'indice la rilegge revocata.
    const revoked = JSON.stringify({ versione: 1, brani: [] });
    mocks.get
      .mockImplementationOnce(async () => storedText(MANIFEST))
      .mockImplementation(async () => storedText(revoked));
    const current = (await version()).body.version;
    const first = await home(`?v=${current}`);
    expect(first.body.items.find((item) => item.id === DECLARED)?.artistSlug).toBe('lucio-dalla');
    expect(first.response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    // Senza `version`: il client lo richiede a ogni controllo, come prima.
    expect(first.body.version).toBeUndefined();

    // L'indice rilegge il manifest (~5 minuti) a store invariato: stessa versione, link revocati.
    vi.setSystemTime(T0 + 5 * 60_000 + 1000);
    expect((await version()).body.version).toBe(current);
    const later = await home(`?v=${current}`);
    expect(later.body.items.find((item) => item.id === DECLARED)?.artistSlug).toBeNull();
    expect(later.response.headers.get('cache-control')).not.toBe(LONG);
  });

  it('rate-limit superato su una versione non attuale: 429', async () => {
    serveStore();
    mocks.enforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const response = await homeGET(
      new Request('https://solco.test/api/music/home-tracks?v=0000000000000000'),
    );
    expect(response.status).toBe(429);
  });

  it('link non ancora pronti (indice lento): senza `version` e cache breve, così il client richiede', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.list.mockImplementation(async () => ({ blobs: STORE, hasMore: false }));
    // Il manifest non arriva mai: l'indice resta in costruzione.
    mocks.get.mockImplementation(() => new Promise(() => undefined));
    const current = await versionGET().then((response) => response.json());
    const pending = home(`?v=${current.version}`);
    await vi.advanceTimersByTimeAsync(1600);
    const { response, body } = await pending;
    expect(response.headers.get('cache-control')).toBe(SHORT);
    expect(body.version).toBeUndefined();
    expect(body.items.every((item) => item.artistSlug === null)).toBe(true);
  });

  it('elenco degradato (store in errore, ultimo elenco buono): niente cache lunga né `version`', async () => {
    serveStore();
    const current = (await version()).body.version;
    mocks.list.mockRejectedValue(new Error('blob down'));
    vi.setSystemTime(T0 + 91_000);
    const { response, body } = await home(`?v=${current}`);
    expect(body.items).toHaveLength(2);
    expect(response.headers.get('cache-control')).toBe(SHORT);
    expect(body.version).toBeUndefined();
  });

  it('una nuova versione porta un nuovo URL con il contenuto nuovo', async () => {
    serveStore();
    const first = (await version()).body.version;
    serveStore([...STORE, blob('Novità/Mina - Nuova.mp3', '2026-11-15T09:00:00.000Z')]);
    vi.setSystemTime(T0 + 91_000);
    const second = (await version()).body.version;
    expect(second).not.toBe(first);
    const { response, body } = await home(`?v=${second}`);
    expect(response.headers.get('cache-control')).toBe(LONG);
    expect(body.items[0]?.id).toBe('Novità/Mina - Nuova.mp3');
  });
});
