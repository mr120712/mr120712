// @polsia:user-owned — versione del catalogo dei brani in evidenza e UNICO elenco dello store
// condiviso: impronta stabile a contenuto invariato e diversa per ogni file aggiunto, tolto o
// sostituito (diritti.json compreso, mai public-uploads/); un elenco per finestra (~30 s) condiviso
// da versione, Home e indice della ricerca; stale-while-revalidate limitato; ultimo elenco buono in
// caso di errore; nessun timer sul server; contatore «Aggiorna ora» (cache ~10 s) che forza un
// elenco nuovo e cambia la versione (mai una versione "contatore 0" in cache se la prima lettura
// fallisce: si riprova dopo ~1 s); indice della ricerca che segue la versione.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  databaseUrl: undefined as string | undefined,
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token, DATABASE_URL: mocks.databaseUrl };
  },
}));
vi.mock('@/lib/db', () => ({
  prisma: { featuredCatalogState: { findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: vi.fn(async () => null),
  getRateLimitIdentity: vi.fn(() => 'ip:192.0.2.9'),
}));

import { GET as homeGET } from '@/app/api/music/home-tracks/route';
import { GET as versionGET } from '@/app/api/music/home-tracks/version/route';
import { HomeTracksResponseSchema, HomeTracksVersionSchema } from '@/lib/contracts/home-tracks';
import {
  CATALOG_VERSION_PATTERN,
  homeStoreFingerprint,
  loadFeaturedCatalogState,
} from '@/lib/music/featured-catalog.server';
import { bumpFeaturedCatalogGeneration } from '@/lib/music/featured-catalog-generation.server';
import {
  clearFeaturedSearchCacheForTests,
  getFeaturedArtist,
  loadFeaturedHomeLinks,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';
import { collectHomeStore } from '@/lib/music/home-tracks.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const DECLARED = 'Cantautori/Lucio Dalla - Caruso.mp3';
const NEW_TRACK = 'Novità/Mina - Nuova.mp3';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

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

const BASE = [
  blob(DECLARED, '2026-10-02T00:00:00.000Z'),
  blob('Cantautori/cover.jpg'),
  blob('Download/Artista - Hit.mp3', '2026-10-03T00:00:00.000Z'),
  blob('diritti.json', '2026-10-04T00:00:00.000Z', 200),
];

let storeBlobs = BASE;
let manifestText = manifest([DECLARED]);

function serveStore(blobs = BASE, text = manifest([DECLARED])) {
  storeBlobs = blobs;
  manifestText = text;
  mocks.list.mockImplementation(async () => ({ blobs: storeBlobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(manifestText));
}

const T0 = new Date('2026-11-15T10:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.findUnique.mockReset();
  mocks.upsert.mockReset();
  mocks.token = 'tok_test';
  mocks.databaseUrl = undefined;
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function listingOf(blobs: ReturnType<typeof blob>[]) {
  mocks.list.mockResolvedValueOnce({ blobs, hasMore: false });
  return collectHomeStore('tok_test', new Set(['diritti.json']));
}

describe('impronta del catalogo', () => {
  it('stabile per lo stesso contenuto, anche in un ordine diverso', async () => {
    const a = homeStoreFingerprint(await listingOf(BASE));
    const b = homeStoreFingerprint(await listingOf([...BASE].reverse()));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toBe(a);
  });

  it('diversa se un file è aggiunto, tolto o sostituito, o se cambia diritti.json', async () => {
    const base = homeStoreFingerprint(await listingOf(BASE));
    const variants = [
      // Brano aggiunto / tolto.
      [...BASE, blob(NEW_TRACK)],
      BASE.filter((item) => item.pathname !== 'Download/Artista - Hit.mp3'),
      // Brano sostituito (stesso nome: nuova data di caricamento o nuova dimensione).
      BASE.map((item) =>
        item.pathname === DECLARED ? blob(DECLARED, '2026-11-01T00:00:00.000Z') : item,
      ),
      BASE.map((item) => (item.pathname === DECLARED ? { ...item, size: 2000 } : item)),
      // diritti.json ricaricato (revoca o nuova voce) o tolto.
      BASE.map((item) =>
        item.pathname === 'diritti.json'
          ? blob('diritti.json', '2026-11-02T00:00:00.000Z', 180)
          : item,
      ),
      BASE.filter((item) => item.pathname !== 'diritti.json'),
      // Copertina o testo accanto a un brano.
      [...BASE, blob('Download/Artista - Hit.jpg')],
      [...BASE, blob('Cantautori/Lucio Dalla - Caruso.lrc')],
    ];
    const prints = new Set([base]);
    for (const blobs of variants) prints.add(homeStoreFingerprint(await listingOf(blobs)));
    expect(prints.size).toBe(variants.length + 1);
  });

  it('gli upload degli utenti (public-uploads/) e gli altri file non contano', async () => {
    const base = homeStoreFingerprint(await listingOf(BASE));
    const withUploads = homeStoreFingerprint(
      await listingOf([
        ...BASE,
        blob('public-uploads/utente - Canzone.mp3'),
        blob('public-uploads/cover.jpg'),
        blob('note-varie.pdf'),
      ]),
    );
    expect(withUploads).toBe(base);
  });
});

describe('versione ed elenco condiviso', () => {
  it('UN elenco per finestra condiviso da versione, Home, ricerca e pagine d’artista', async () => {
    serveStore();
    const state = await loadFeaturedCatalogState();
    expect(state.version).toMatch(CATALOG_VERSION_PATTERN);
    const versionBody = HomeTracksVersionSchema.parse(await (await versionGET()).json());
    expect(versionBody.version).toBe(state.version);
    const home = await homeGET(
      new Request(`https://solco.test/api/music/home-tracks?v=${state.version}`),
    );
    expect(HomeTracksResponseSchema.parse(await home.json()).version).toBe(state.version);
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect((await getFeaturedArtist('lucio-dalla')).outcome).toBe('found');
    await homeGET(new Request('https://solco.test/api/music/home-tracks'));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('versione stabile a store invariato, nuova quando l’amministratore aggiunge un brano', async () => {
    serveStore();
    const first = await loadFeaturedCatalogState();
    vi.setSystemTime(T0 + 2 * 60_000);
    const same = await loadFeaturedCatalogState();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(same.version).toBe(first.version);
    expect(same.updatedAt).toBe(first.updatedAt);

    serveStore([...BASE, blob(NEW_TRACK, '2026-11-15T09:59:00.000Z')]);
    vi.setSystemTime(T0 + 4 * 60_000);
    const next = await loadFeaturedCatalogState();
    expect(next.version).not.toBe(first.version);
    expect(next.updatedAt).toBe(new Date(T0 + 4 * 60_000).toISOString());
  });

  it('scaduta la finestra: risponde SUBITO con l’ultima versione e rielenca in background, una volta', async () => {
    serveStore();
    const first = await loadFeaturedCatalogState();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveStore([...BASE, blob(NEW_TRACK)]);
    mocks.list.mockImplementation(async () => {
      await gate;
      return { blobs: storeBlobs, hasMore: false };
    });
    vi.setSystemTime(T0 + 31_000);
    const [a, b] = await Promise.all([loadFeaturedCatalogState(), loadFeaturedCatalogState()]);
    expect(a.version).toBe(first.version);
    expect(b.version).toBe(first.version);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(async () =>
      expect((await loadFeaturedCatalogState()).version).not.toBe(first.version),
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('oltre la finestra + un minuto (istanza rimasta ferma): aspetta l’elenco nuovo', async () => {
    serveStore();
    const first = await loadFeaturedCatalogState();
    serveStore([...BASE, blob(NEW_TRACK)]);
    vi.setSystemTime(T0 + 91_000);
    expect((await loadFeaturedCatalogState()).version).not.toBe(first.version);
  });

  it('elenco fallito: resta l’ultima versione buona, segnalata stale, riprovata dopo la finestra', async () => {
    serveStore();
    const good = await loadFeaturedCatalogState();
    mocks.list.mockRejectedValue(new Error('blob down'));
    vi.setSystemTime(T0 + 91_000);
    const failed = await loadFeaturedCatalogState();
    expect(failed).toMatchObject({ version: good.version, stale: true });
    expect(failed.listing.audio).toHaveLength(2);
    // Nessun martellamento: dentro la finestra non si riprova.
    vi.setSystemTime(T0 + 100_000);
    await loadFeaturedCatalogState();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    // Lo store torna: la versione buona resta la stessa (store invariato), non più stale.
    serveStore();
    vi.setSystemTime(T0 + 200_000);
    expect(await loadFeaturedCatalogState()).toMatchObject({ version: good.version, stale: false });
  });

  it('primo elenco fallito (niente di buono): stale; scaduta la finestra si aspetta un elenco nuovo', async () => {
    mocks.list.mockRejectedValueOnce(new Error('blob down'));
    const failed = await loadFeaturedCatalogState();
    expect(failed.stale).toBe(true);
    expect(failed.listing.audio).toEqual([]);
    serveStore();
    vi.setSystemTime(T0 + 31_000);
    const recovered = await loadFeaturedCatalogState();
    expect(recovered.stale).toBe(false);
    expect(recovered.listing.audio).toHaveLength(2);
  });

  it('nessun timer sul server: senza richieste lo store non si interroga mai', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    serveStore();
    await loadFeaturedCatalogState();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('Blob non configurato: versione valida di un catalogo vuoto, nessuna chiamata allo store', async () => {
    mocks.token = undefined;
    const state = await loadFeaturedCatalogState();
    expect(state).toMatchObject({ configured: false, stale: false });
    expect(state.version).toMatch(CATALOG_VERSION_PATTERN);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('contatore «Aggiorna ora»', () => {
  it('senza database nessuna lettura: il catalogo segue solo lo store', async () => {
    serveStore();
    await loadFeaturedCatalogState();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('un «Aggiorna ora» su un’altra istanza: visto entro ~10 s, elenco nuovo subito e nuova versione', async () => {
    mocks.databaseUrl = 'postgresql://test';
    mocks.findUnique.mockResolvedValue({ generation: 4 });
    serveStore();
    const first = await loadFeaturedCatalogState();
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(first.generation).toBe(4);

    // L'altra istanza incrementa: per ~10 s questa usa il valore in cache.
    mocks.findUnique.mockResolvedValue({ generation: 5 });
    vi.setSystemTime(T0 + 5000);
    expect((await loadFeaturedCatalogState()).version).toBe(first.version);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Dopo ~10 s lo vede: rielenca SUBITO (anche dentro la finestra di 30 s) e cambia versione,
    // anche a store invariato.
    vi.setSystemTime(T0 + 10_001);
    const bumped = await loadFeaturedCatalogState();
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(bumped.generation).toBe(5);
    expect(bumped.version).not.toBe(first.version);
  });

  it('database lento o in errore: resta l’ultimo valore, riletto solo dopo ~10 s', async () => {
    mocks.databaseUrl = 'postgresql://test';
    mocks.findUnique.mockResolvedValueOnce({ generation: 2 });
    serveStore();
    const first = await loadFeaturedCatalogState();
    mocks.findUnique.mockRejectedValue(new Error('db down'));
    vi.setSystemTime(T0 + 10_001);
    const after = await loadFeaturedCatalogState();
    expect(after.generation).toBe(2);
    expect(after.version).toBe(first.version);
    vi.setSystemTime(T0 + 15_000);
    await loadFeaturedCatalogState();
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it('istanza appena avviata, prima lettura fallita: versione provvisoria (mai in cache), riprovata dopo ~1 s', async () => {
    mocks.databaseUrl = 'postgresql://test';
    mocks.findUnique.mockRejectedValueOnce(new Error('cold connect')).mockResolvedValue({
      generation: 7,
    });
    serveStore();
    const cold = await loadFeaturedCatalogState();
    expect(cold).toMatchObject({ generation: 0, generationKnown: false });
    // La versione provvisoria non va nella CDN, né l'elenco per quella versione in cache lunga.
    const versionResponse = await versionGET();
    expect(versionResponse.status).toBe(200);
    expect(versionResponse.headers.get('cache-control')).toBe('no-store');
    const home = await homeGET(
      new Request(`https://solco.test/api/music/home-tracks?v=${cold.version}`),
    );
    expect(home.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=5');
    expect(HomeTracksResponseSchema.parse(await home.json()).version).toBeUndefined();
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);

    // Dopo ~1 secondo (non ~10) si rilegge: valore vero, versione affidabile e in cache.
    vi.setSystemTime(T0 + 1001);
    const known = await loadFeaturedCatalogState();
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
    expect(known).toMatchObject({ generation: 7, generationKnown: true });
    const cached = await versionGET();
    expect(cached.headers.get('cache-control')).toContain('s-maxage=');
    expect(HomeTracksVersionSchema.parse(await cached.json()).version).toBe(known.version);
  });

  it('database irraggiungibile all’avvio: dopo alcuni tentativi 0 vale come noto (niente provvisorio per sempre)', async () => {
    mocks.databaseUrl = 'postgresql://test';
    mocks.findUnique.mockRejectedValue(new Error('db down'));
    serveStore();
    expect((await loadFeaturedCatalogState()).generationKnown).toBe(false);
    vi.setSystemTime(T0 + 1001);
    expect((await loadFeaturedCatalogState()).generationKnown).toBe(false);
    vi.setSystemTime(T0 + 2002);
    const settled = await loadFeaturedCatalogState();
    expect(settled).toMatchObject({ generation: 0, generationKnown: true });
    expect(mocks.findUnique).toHaveBeenCalledTimes(3);
    // Poi la finestra normale di ~10 s: niente martellamento.
    vi.setSystemTime(T0 + 5000);
    await loadFeaturedCatalogState();
    expect(mocks.findUnique).toHaveBeenCalledTimes(3);
  });

  it('l’incremento su questa istanza vale subito: elenco nuovo e indice ricostruito', async () => {
    mocks.databaseUrl = 'postgresql://test';
    mocks.findUnique.mockResolvedValue({ generation: 0 });
    mocks.upsert.mockResolvedValue({ generation: 1 });
    serveStore();
    const first = await loadFeaturedCatalogState();
    await loadFeaturedHomeLinks(first);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    expect(await bumpFeaturedCatalogGeneration()).toBe(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'singleton' },
        update: expect.objectContaining({ generation: { increment: 1 } }),
      }),
    );
    const bumped = await loadFeaturedCatalogState();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(bumped.version).not.toBe(first.version);
    const links = await loadFeaturedHomeLinks(bumped);
    expect(links?.version).toBe(bumped.version);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});

describe('l’indice della ricerca segue la versione', () => {
  it('un brano appena dichiarato è ricercabile entro la finestra, non dopo ~5 minuti', async () => {
    serveStore();
    expect((await searchFeaturedTracks('mina')).tracks).toEqual([]);
    serveStore(
      [
        ...BASE.filter((item) => item.pathname !== 'diritti.json'),
        blob(NEW_TRACK),
        blob('diritti.json', '2026-11-15T09:59:30.000Z', 260),
      ],
      manifest([DECLARED, NEW_TRACK]),
    );
    vi.setSystemTime(T0 + 91_000);
    expect((await searchFeaturedTracks('mina')).tracks.map((track) => track.id)).toEqual([
      NEW_TRACK,
    ]);
  });

  it('una revoca (diritti.json ricaricato senza la voce) vale entro la finestra', async () => {
    serveStore();
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    serveStore(
      [
        ...BASE.filter((item) => item.pathname !== 'diritti.json'),
        blob('diritti.json', '2026-11-15T09:59:30.000Z', 40),
      ],
      manifest([]),
    );
    vi.setSystemTime(T0 + 91_000);
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
    expect((await getFeaturedArtist('lucio-dalla')).outcome).toBe('not_found');
  });

  it('versione invariata: l’indice non si ricostruisce a ogni elenco', async () => {
    serveStore();
    await searchFeaturedTracks('caruso');
    for (const minutes of [1, 2, 3, 4]) {
      vi.setSystemTime(T0 + minutes * 60_000 + 31_000);
      await searchFeaturedTracks('caruso');
    }
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
