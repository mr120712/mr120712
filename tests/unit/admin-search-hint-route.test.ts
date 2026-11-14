// @polsia:user-owned — GET /api/admin/featured-rights/search-hint (avviso «Solo per admin» nella
// ricerca): accesso solo per admin con email verificata (401/403/503, senza toccare lo store né il
// limite), intestazioni private (no-store + Vary: Cookie) su OGNI risposta, solo conteggi (nessun
// titolo, artista o percorso nel JSON), la STESSA corrispondenza della ricerca vera su uno store di
// prova con brani dichiarati e non dichiarati (stessa rilevanza, stessa soglia, stesse regole del
// manifest), gli stati del manifest, UN elenco dello store per finestra di cache (stesse finestre
// dell'indice della ricerca, che l'avviso riusa), conteggi coerenti con ciò che la ricerca mostra
// anche subito dopo una modifica a diritti.json, lo stesso limite di search-all (bucket
// music.search, stessa identità). In più: GET /api/music/search-all resta identico per un admin
// (nessun campo dell'avviso, stessa cache, nessuna chiamata all'avviso).
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  enforceRateLimit: vi.fn(),
  searchMusic: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
  hintCalls: vi.fn(),
  override: null as null | ((query: string) => Promise<unknown>),
  token: 'tok_test' as string | undefined,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
// Stessa regola di identità del modulo vero: l'utente autenticato, altrimenti l'IP d'ingresso.
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null, headers: Headers) =>
    userId ? `user:${userId}` : headers.get('x-real-ip') ? `ip:${headers.get('x-real-ip')}` : null,
}));
// Solo per search-all: le altre fonti (i brani in evidenza usano il modulo vero sullo store finto).
vi.mock('@/lib/music/music-api.server', () => ({ searchMusic: mocks.searchMusic }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));
// Il modulo vero, osservato: si conta chi lo chiama e si può forzare una risposta fuori contratto.
vi.mock('@/lib/admin/featured-search-hint.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/featured-search-hint.server')>();
  return {
    ...actual,
    getFeaturedSearchHint: (query: string) => {
      mocks.hintCalls(query);
      return mocks.override ? mocks.override(query) : actual.getFeaturedSearchHint(query);
    },
  };
});

import { GET } from '@/app/api/admin/featured-rights/search-hint/route';
import { GET as searchAll } from '@/app/api/music/search-all/route';
import {
  clearFeaturedSearchHintCacheForTests,
  SEARCH_HINT_FAILURE_TTL_MS,
  SEARCH_HINT_TTL_MS,
} from '@/lib/admin/featured-search-hint.server';
import { AdminSearchHintSchema } from '@/lib/contracts/admin-search-hint';
import { UnifiedSearchResponseSchema } from '@/lib/contracts/unified-search';
import {
  clearFeaturedSearchCacheForTests,
  FEATURED_MIN_SCORE,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';
import { trackNameFromPathname } from '@/lib/music/home-tracks.server';
import { featuredRelevance } from '@/lib/music/unified-search';

const PUBLIC = 'https://store.public.blob.vercel-storage.com';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

function blob(
  pathname: string,
  base = PRIVATE,
  uploadedAt = '2026-10-01T00:00:00.000Z',
  size = 1000,
) {
  const url = `${base}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

// Il nome con l'accento è nello store in forma scomposta (NFD, caricato da un Mac) e nel manifest
// in forma composta (NFC): la ricerca lo considera dichiarato, e così l'avviso.
const CITTA_NFD = 'Cantautori/Autrice - Città d’estate.mp3'.normalize('NFD');
const CITTA_NFC = 'Cantautori/Autrice - Città d’estate.mp3'.normalize('NFC');

const DECLARED = [
  'Rock italiano/Lucio Dalla - Caruso.mp3',
  CITTA_NFD,
  // Senza artista nel nome: la ricerca usa "Solco" come artista ("Solco Pioggia").
  'Pioggia.mp3',
];
const UNDECLARED = [
  'Spotify/Lucio Dalla - Caruso (Live).mp3',
  'Spotify/Altro - Caruso remix.mp3',
  'Novità/Band - Singolo.flac',
  'Novità/Band - Caruso per sempre.mp3',
];

const STORE = [
  blob(DECLARED[0] as string, PRIVATE, '2026-10-02T00:00:00.000Z'),
  blob(DECLARED[1] as string, PUBLIC, '2026-10-03T00:00:00.000Z'),
  blob(DECLARED[2] as string, PRIVATE, '2026-10-04T00:00:00.000Z'),
  blob(UNDECLARED[0] as string, PUBLIC, '2026-10-05T00:00:00.000Z'),
  blob(UNDECLARED[1] as string, PRIVATE, '2026-10-06T00:00:00.000Z'),
  blob(UNDECLARED[2] as string, PRIVATE, '2026-10-07T00:00:00.000Z'),
  blob(UNDECLARED[3] as string, PRIVATE, '2026-10-08T00:00:00.000Z'),
  blob('Rock italiano/cover.jpg', PRIVATE),
  // Upload degli utenti: mai brani in evidenza, né dichiarati né nascosti.
  blob('public-uploads/utente - Caruso.mp3', PUBLIC, '2026-10-09T00:00:00.000Z'),
  blob('diritti.json', PRIVATE, '2026-10-10T00:00:00.000Z', 400),
];

function rights(files: string[]) {
  return JSON.stringify({
    versione: 1,
    brani: [
      ...files.map((file) => ({ file, licenza: 'propria', titolare: 'Solco' })),
      // Una voce sbagliata viene ignorata da sola (licenza non commerciale): il resto vale.
      { file: UNDECLARED[2], licenza: 'cc-by-nc', titolare: 'Band' },
    ],
  });
}

const VALID_MANIFEST = rights([DECLARED[0] as string, CITTA_NFC, DECLARED[2] as string]);

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

function serveStore(blobs = STORE, manifest = VALID_MANIFEST) {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(manifest));
}

const withoutManifest = () => STORE.filter((item) => item.pathname !== 'diritti.json');

function request(query: string | null, headers: Record<string, string> = {}) {
  const url = new URL('https://solco.test/api/admin/featured-rights/search-hint');
  if (query !== null) url.searchParams.set('q', query);
  return GET(
    new Request(url, {
      headers: { cookie: 'better-auth.session_token=fake', 'x-real-ip': '192.0.2.9', ...headers },
    }),
  );
}

async function hint(query: string) {
  const response = await request(query);
  expect(response.status).toBe(200);
  return AdminSearchHintSchema.parse(await response.json());
}

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

/** Brani pertinenti con la funzione e la soglia della ricerca vera (riferimento indipendente). */
function relevantCount(pathnames: readonly string[], query: string) {
  return pathnames.filter(
    (pathname) => featuredRelevance(trackNameFromPathname(pathname), query) >= FEATURED_MIN_SCORE,
  ).length;
}

const T0 = new Date('2026-11-14T10:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.getSession.mockReset().mockResolvedValue({ user: admin });
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.hintCalls.mockReset();
  mocks.override = null;
  mocks.token = 'tok_test';
  mocks.searchMusic.mockReset().mockResolvedValue({
    outcome: 'no_results',
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
  });
  mocks.listStations.mockReset().mockResolvedValue({ outcome: 'no_results', stations: [] });
  mocks.searchPodcasts.mockReset().mockResolvedValue({ outcome: 'no_results', podcasts: [] });
  clearFeaturedSearchHintCacheForTests();
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  serveStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('search-hint: accesso', () => {
  it.each([
    ['senza sessione', 401, 'unauthorized', null],
    [
      'utente normale',
      403,
      'forbidden',
      { user: { id: 'u-1', role: 'user', emailVerified: true } },
    ],
    [
      'admin con email NON verificata',
      403,
      'forbidden',
      { user: { ...admin, emailVerified: false } },
    ],
    ['senza ruolo', 403, 'forbidden', { user: { id: 'u-2', emailVerified: true } }],
  ])('%s → %i privato, senza store, limite o conteggi', async (_label, status, error, session) => {
    mocks.getSession.mockResolvedValue(session);
    const response = await request('caruso');
    expect(response.status).toBe(status);
    expectPrivate(response);
    const body = await response.json();
    expect(body).toEqual({ error });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.hintCalls).not.toHaveBeenCalled();
  });

  it('sessione non leggibile (DB giù) → 503 privato, non 401', async () => {
    mocks.getSession.mockRejectedValue(new Error('db down'));
    const response = await request('caruso');
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'session_unavailable' });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('a chi non è admin non dice nulla nemmeno di una query non valida (prima il permesso)', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-1', role: 'user', emailVerified: true } });
    const response = await request('');
    expect(response.status).toBe(403);
    expectPrivate(response);
  });
});

describe('search-hint: query e intestazioni', () => {
  it('valida la query come search-all (spazi tolti, da 1 a 80 caratteri), con 400 privato', async () => {
    for (const query of [null, '', '    ', 'x'.repeat(81)]) {
      const response = await request(query);
      expect(response.status).toBe(400);
      expectPrivate(response);
      expect((await response.json()).errors.q).toContain('1 a 80');

      // search-all rifiuta le stesse query.
      const url = new URL('https://solco.test/api/music/search-all');
      if (query !== null) url.searchParams.set('q', query);
      expect((await searchAll(new Request(url))).status).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();

    // Esattamente 80 caratteri (dopo aver tolto gli spazi) va bene.
    const ok = await request(`  ${'a'.repeat(80)}  `);
    expect(ok.status).toBe(200);
    expectPrivate(ok);
  });

  it('risposta 200 privata, con SOLO lo stato del manifest e due conteggi', async () => {
    const response = await request('caruso');
    expect(response.status).toBe(200);
    expectPrivate(response);
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(['manifest', 'matchedDeclared', 'matchedUndeclared']);
    expect(body).toEqual({ manifest: 'valid', matchedDeclared: 1, matchedUndeclared: 3 });
    // Nessun titolo, artista, cartella o percorso: né come valore né come chiave.
    for (const leak of [
      'Caruso',
      'Dalla',
      'Spotify',
      'Rock',
      'Novit',
      '.mp3',
      '.flac',
      'uploads',
    ]) {
      expect(raw).not.toContain(leak);
    }
    for (const key of ['id', 'title', 'artist', 'pathname', 'file', 'url', 'tracks', 'titles']) {
      expect(raw).not.toContain(`"${key}"`);
    }
  });

  it('una risposta fuori contratto (un campo in più) non esce: 500 privato e generico', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.override = async () => ({
      manifest: 'valid',
      matchedDeclared: 0,
      matchedUndeclared: 1,
      titles: ['Caruso (Live)'],
    });
    const response = await request('caruso');
    expect(response.status).toBe(500);
    expectPrivate(response);
    const raw = await response.text();
    expect(raw).not.toContain('Caruso');
    expect(JSON.parse(raw)).toEqual({ error: 'search_hint_unavailable' });
    // Nei log solo il tipo di errore, mai la query o i titoli.
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Caruso');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('caruso');
  });
});

describe('search-hint: la stessa corrispondenza della ricerca vera', () => {
  const queries = [
    'caruso',
    'Caruso',
    'lucio dalla',
    'Lucio Dalla - Caruso',
    'lucio dalla caruso',
    'citta',
    'Città d’estate',
    'autrice',
    'solco pioggia',
    'pioggia',
    'band',
    'band singolo',
    'per sempre',
    'remix',
    'ar',
    'vasco',
    'utente',
  ];

  it.each(queries)(
    '«%s»: dichiarati = ciò che la ricerca mostra, nascosti = non dichiarati pertinenti',
    async (query) => {
      const result = await hint(query);
      const shown = await searchFeaturedTracks(query, Number.MAX_SAFE_INTEGER);
      expect(result.manifest).toBe('valid');
      expect(result.matchedDeclared).toBe(shown.tracks.length);
      expect(result.matchedDeclared).toBe(relevantCount(DECLARED, query));
      expect(result.matchedUndeclared).toBe(relevantCount(UNDECLARED, query));
    },
  );

  it('i conteggi attesi sullo store di prova (non banali)', async () => {
    expect(await hint('caruso')).toEqual({
      manifest: 'valid',
      matchedDeclared: 1,
      matchedUndeclared: 3,
    });
    // "Artista - Titolo" come nei nomi dei file: solo il brano dichiarato e il Live.
    expect(await hint('Lucio Dalla - Caruso')).toMatchObject({
      matchedDeclared: 1,
      matchedUndeclared: 1,
    });
    // Accenti e forma Unicode non contano; la voce NFC copre il file NFD.
    expect(await hint('citta')).toMatchObject({ matchedDeclared: 1, matchedUndeclared: 0 });
    // Artista predefinito "Solco" per i brani senza artista, come nella ricerca.
    expect(await hint('solco pioggia')).toMatchObject({ matchedDeclared: 1, matchedUndeclared: 0 });
    // Voce con licenza NC ignorata: il brano resta nascosto.
    expect(await hint('band singolo')).toMatchObject({ matchedDeclared: 0, matchedUndeclared: 1 });
    // Nessun brano pertinente; e gli upload degli utenti non contano mai.
    expect(await hint('vasco')).toEqual({
      manifest: 'valid',
      matchedDeclared: 0,
      matchedUndeclared: 0,
    });
    expect(await hint('utente')).toMatchObject({ matchedDeclared: 0, matchedUndeclared: 0 });
  });

  it('conta TUTTI i brani pertinenti, oltre il tetto dei risultati mostrati', async () => {
    const many = Array.from({ length: 12 }, (_, index) => `Live/Band - Inno ${index + 1}.mp3`);
    serveStore(
      [...STORE, ...many.map((pathname) => blob(pathname))],
      rights([...DECLARED.slice(0, 1), ...many.slice(0, 10)]),
    );
    expect(await hint('inno')).toEqual({
      manifest: 'valid',
      matchedDeclared: 10,
      matchedUndeclared: 2,
    });
  });
});

describe('search-hint: stati del manifest', () => {
  it('diritti.json assente → missing: niente è ricercabile, tutti i pertinenti sono nascosti', async () => {
    serveStore(withoutManifest());
    expect(await hint('caruso')).toEqual({
      manifest: 'missing',
      matchedDeclared: 0,
      matchedUndeclared: 4,
    });
    expect(mocks.get).not.toHaveBeenCalled();
    // Come la ricerca: nessun brano in evidenza.
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
  });

  it.each([
    ['JSON rotto', () => serveStore(STORE, '{ "versione": 1, "brani": [')],
    ['versione sbagliata', () => serveStore(STORE, JSON.stringify({ versione: 2, brani: [] }))],
    ['campo in più', () => serveStore(STORE, JSON.stringify({ versione: 1, brani: [], x: 1 }))],
    [
      'oltre 256 KB',
      () =>
        serveStore(
          STORE.map((item) =>
            item.pathname === 'diritti.json' ? { ...item, size: 256 * 1024 + 1 } : item,
          ),
        ),
    ],
  ])('diritti.json non valido (%s) → invalid', async (_label, serve) => {
    serve();
    expect(await hint('caruso')).toEqual({
      manifest: 'invalid',
      matchedDeclared: 0,
      matchedUndeclared: 4,
    });
    expect((await searchFeaturedTracks('caruso')).tracks).toEqual([]);
  });

  it('Blob non configurato → unavailable, senza toccare lo store', async () => {
    mocks.token = undefined;
    expect(await hint('caruso')).toEqual({
      manifest: 'unavailable',
      matchedDeclared: 0,
      matchedUndeclared: 0,
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('elenco dello store in errore → unavailable (non "assente")', async () => {
    mocks.list.mockRejectedValue(new Error('rete'));
    expect((await hint('caruso')).manifest).toBe('unavailable');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('elenco interrotto prima di trovare diritti.json → unavailable, come la ricerca', async () => {
    // Prima pagina senza diritti.json, la seconda in errore (per l'avviso e per l'indice).
    mocks.list.mockImplementation(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) return { blobs: [STORE[0]], hasMore: true, cursor: 'c1' };
      throw new Error('rete');
    });
    expect(await hint('caruso')).toEqual({
      manifest: 'unavailable',
      matchedDeclared: 0,
      matchedUndeclared: 0,
    });
  });

  it('diritti.json illeggibile (errore dello store) → unavailable', async () => {
    mocks.get.mockRejectedValue(new Error('rete'));
    expect((await hint('caruso')).manifest).toBe('unavailable');
  });
});

describe('search-hint: cache dello store', () => {
  it('stesse finestre dell’indice della ricerca: ~5 minuti, ~1 minuto dopo un errore', () => {
    expect(SEARCH_HINT_TTL_MS).toBe(5 * 60_000);
    expect(SEARCH_HINT_FAILURE_TTL_MS).toBe(60_000);
  });

  it('UN elenco e UNA lettura di diritti.json per finestra, non a ogni ricerca', async () => {
    // Una ricerca vera prima (come search-all, che parte insieme): l'indice ha il suo elenco.
    await searchFeaturedTracks('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    // L'avviso aggiunge UN solo elenco per tutte le query della finestra e riusa l'indice.
    await hint('caruso');
    await hint('lucio');
    await hint('band');
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS - 1);
    await hint('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(2);

    // Finestra scaduta: un elenco per l'avviso e uno per l'indice (che search-all rifarebbe).
    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS + 1);
    await hint('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(4);
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });

  it('richieste concorrenti condividono lo stesso elenco (e lo stesso indice della ricerca)', async () => {
    const results = await Promise.all(['caruso', 'lucio', 'band', 'citta'].map(hint));
    expect(results.map((result) => result.manifest)).toEqual(['valid', 'valid', 'valid', 'valid']);
    // Uno per l'avviso + uno per l'indice, non uno per richiesta.
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('anche uno store non leggibile si richiede al più una volta per finestra (~1 minuto)', async () => {
    mocks.list.mockRejectedValue(new Error('rete'));
    await hint('caruso');
    await hint('lucio');
    // Avviso + indice, una volta sola.
    expect(mocks.list).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + SEARCH_HINT_FAILURE_TTL_MS - 1);
    await hint('caruso');
    expect(mocks.list).toHaveBeenCalledTimes(2);

    vi.setSystemTime(T0 + SEARCH_HINT_FAILURE_TTL_MS + 1);
    serveStore();
    expect((await hint('caruso')).manifest).toBe('valid');
    expect(mocks.list).toHaveBeenCalledTimes(4);
  });

  it('una modifica a diritti.json vale alla finestra successiva, insieme alla ricerca', async () => {
    expect(await hint('band singolo')).toMatchObject({ matchedUndeclared: 1 });
    serveStore(STORE, rights([...DECLARED, UNDECLARED[2] as string]));
    expect(await hint('band singolo')).toMatchObject({ matchedUndeclared: 1 });
    expect((await searchFeaturedTracks('band singolo')).tracks).toHaveLength(0);
    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS + 1);
    expect(await hint('band singolo')).toMatchObject({ matchedDeclared: 1, matchedUndeclared: 0 });
    expect((await searchFeaturedTracks('band singolo')).tracks).toHaveLength(1);
  });
});

describe('search-hint: coerente con ciò che la ricerca mostra, anche subito dopo una modifica', () => {
  const ids = (result: { tracks: Array<{ id: string }> }) => result.tracks.map((track) => track.id);

  // L'indice della ricerca nasce a T0; l'avviso legge lo store per la prima volta DOPO la modifica,
  // quindi i due vedono diritti.json in versioni diverse per qualche minuto.
  it('voce tolta: finché la ricerca mostra il brano, l’avviso non lo conta fra i nascosti', async () => {
    expect(ids(await searchFeaturedTracks('caruso'))).toEqual([DECLARED[0]]);
    serveStore(STORE, rights([CITTA_NFC, DECLARED[2] as string]));

    for (const at of [T0 + 61_000, T0 + 299_000]) {
      vi.setSystemTime(at);
      expect(ids(await searchFeaturedTracks('caruso'))).toEqual([DECLARED[0]]);
      expect(await hint('caruso')).toEqual({
        manifest: 'valid',
        matchedDeclared: 1,
        matchedUndeclared: 3,
      });
    }

    // L'indice si rinnova: il brano esce dalla ricerca e, nello stesso momento, entra fra i nascosti.
    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS + 1);
    expect(ids(await searchFeaturedTracks('caruso'))).toEqual([]);
    expect(await hint('caruso')).toEqual({
      manifest: 'valid',
      matchedDeclared: 0,
      matchedUndeclared: 4,
    });
  });

  it('voce aggiunta: finché la ricerca non mostra il brano, l’avviso lo conta fra i nascosti', async () => {
    expect(ids(await searchFeaturedTracks('band singolo'))).toEqual([]);
    serveStore(STORE, rights([...DECLARED, UNDECLARED[2] as string]));

    vi.setSystemTime(T0 + 61_000);
    expect(ids(await searchFeaturedTracks('band singolo'))).toEqual([]);
    expect(await hint('band singolo')).toEqual({
      manifest: 'valid',
      matchedDeclared: 0,
      matchedUndeclared: 1,
    });

    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS + 1);
    expect(ids(await searchFeaturedTracks('band singolo'))).toEqual([UNDECLARED[2]]);
    expect(await hint('band singolo')).toEqual({
      manifest: 'valid',
      matchedDeclared: 1,
      matchedUndeclared: 0,
    });
  });

  it('diritti.json appena tolto: mai «nessun brano compare» sopra brani che compaiono', async () => {
    expect(ids(await searchFeaturedTracks('caruso'))).toEqual([DECLARED[0]]);
    serveStore(withoutManifest());

    vi.setSystemTime(T0 + 61_000);
    // La ricerca mostra ancora il brano (indice di T0): per questa query il manifest in uso è valido.
    expect(await hint('caruso')).toEqual({
      manifest: 'valid',
      matchedDeclared: 1,
      matchedUndeclared: 3,
    });
    // Dove la ricerca non mostra nulla, l'avviso dice già che diritti.json non c'è.
    expect(await hint('band')).toEqual({
      manifest: 'missing',
      matchedDeclared: 0,
      matchedUndeclared: 2,
    });

    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS + 1);
    expect(ids(await searchFeaturedTracks('caruso'))).toEqual([]);
    expect(await hint('caruso')).toEqual({
      manifest: 'missing',
      matchedDeclared: 0,
      matchedUndeclared: 4,
    });
  });

  it('diritti.json appena caricato: finché la ricerca non mostra nulla, tutto è nascosto', async () => {
    serveStore(withoutManifest());
    expect(ids(await searchFeaturedTracks('caruso'))).toEqual([]);
    serveStore();

    vi.setSystemTime(T0 + 61_000);
    expect(await hint('caruso')).toEqual({
      manifest: 'valid',
      matchedDeclared: 0,
      matchedUndeclared: 4,
    });

    vi.setSystemTime(T0 + SEARCH_HINT_TTL_MS + 1);
    expect(ids(await searchFeaturedTracks('caruso'))).toEqual([DECLARED[0]]);
    expect(await hint('caruso')).toEqual({
      manifest: 'valid',
      matchedDeclared: 1,
      matchedUndeclared: 3,
    });
  });

  it('indice della ricerca non leggibile → unavailable (la ricerca non mostra brani in evidenza)', async () => {
    // L'indice fallisce (store giù a T0) e resta così per ~1 minuto; l'avviso legge dopo.
    mocks.list.mockRejectedValue(new Error('rete'));
    expect((await searchFeaturedTracks('caruso')).outcome).toBe('unavailable');
    serveStore();
    vi.setSystemTime(T0 + 30_000);
    expect(await hint('caruso')).toEqual({
      manifest: 'unavailable',
      matchedDeclared: 0,
      matchedUndeclared: 0,
    });
  });
});

describe('search-hint: limite condiviso con search-all', () => {
  it('usa il bucket music.search con la stessa identità di search-all; un 429 resta privato', async () => {
    await request('caruso');
    await searchAll(
      new Request('https://solco.test/api/music/search-all?q=caruso&featured=1', {
        headers: { cookie: 'better-auth.session_token=fake', 'x-real-ip': '192.0.2.9' },
      }),
    );
    // Un solo bucket e una sola identità per le due richieste: nessun limite nuovo.
    expect(mocks.enforceRateLimit.mock.calls).toEqual([
      ['music.search', 'user:admin-1'],
      ['music.search', 'user:admin-1'],
    ]);

    clearFeaturedSearchHintCacheForTests();
    mocks.list.mockClear();
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json(
        { error: 'rate_limited', retryAfterSeconds: 5 },
        { status: 429, headers: { 'Retry-After': '5' } },
      ),
    );
    const limited = await request('caruso');
    expect(limited.status).toBe(429);
    expectPrivate(limited);
    expect(limited.headers.get('retry-after')).toBe('5');
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.hintCalls).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/music/search-all resta identico', () => {
  async function unified(session: unknown) {
    mocks.getSession.mockResolvedValue(session);
    const response = await searchAll(
      new Request('https://solco.test/api/music/search-all?q=caruso&featured=1', {
        headers: { cookie: 'better-auth.session_token=fake', 'x-real-ip': '192.0.2.9' },
      }),
    );
    expect(response.status).toBe(200);
    return { response, raw: await response.text() };
  }

  it('per un admin la risposta e la cache sono quelle di chiunque, senza campi dell’avviso', async () => {
    const asAdmin = await unified({ user: admin });
    const anonymous = await unified(null);
    const asUser = await unified({ user: { id: 'u-1', role: 'user', emailVerified: true } });

    expect(asAdmin.raw).toBe(anonymous.raw);
    expect(asUser.raw).toBe(anonymous.raw);
    const cacheControl = anonymous.response.headers.get('cache-control');
    expect(asAdmin.response.headers.get('cache-control')).toBe(cacheControl);
    expect(cacheControl).toBe('public, max-age=0, s-maxage=60');
    expect(asAdmin.response.headers.get('vary')).toBeNull();

    // Solo il brano dichiarato; nessuna traccia dell'avviso o dei brani non dichiarati.
    const body = UnifiedSearchResponseSchema.parse(JSON.parse(asAdmin.raw));
    expect(body.sources.featured?.tracks.map((track) => track.id)).toEqual([DECLARED[0]]);
    for (const leak of ['manifest', 'matchedDeclared', 'matchedUndeclared', 'Live', 'remix']) {
      expect(asAdmin.raw).not.toContain(leak);
    }
    // search-all non chiama mai l'avviso.
    expect(mocks.hintCalls).not.toHaveBeenCalled();
  });

  it('il codice di search-all non importa l’avviso', () => {
    const source = readFileSync(
      new URL('../../src/app/api/music/search-all/route.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/search-hint|featured-search-hint|admin-search-hint/);
  });
});
