// @polsia:user-owned — GET /api/music/library/search («Le tue playlist» nella ricerca): sessione
// obbligatoria (401), intestazioni private (no-store + Vary: Cookie) su ogni risposta, SOLO le righe
// di chi chiama (le playlist di un secondo utente non compaiono mai), validazione della query come
// search-all, stesso limite di search-all (bucket music.search, stessa identità), confronto senza
// maiuscole né accenti, tetti, mai metadati YouTube scaduti. In più: GET /api/music/search-all resta
// identico per un utente con la sessione (nessun dato della Libreria, nessuna lettura del DB,
// sempre cacheabile in CDN). Prisma è un DB in memoria che RISPETTA i filtri `where`: una query
// senza filtro per utente restituirebbe le righe di tutti e farebbe fallire i test.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CollectionRow = {
  id: string;
  userId: string;
  name: string;
  kind: string;
  description: string | null;
  createdAt: Date;
};
type ItemRow = {
  id: string;
  collectionId: string;
  source: string;
  sourceId: string;
  title: string | null;
  creatorName: string | null;
  artworkUrl: string | null;
  sourceUrl: string | null;
  artistUrl: string | null;
  durationSeconds: number | null;
  createdAt: Date;
  expiresAt: Date | null;
};
type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

const memory = vi.hoisted(() => ({
  userId: 'account-a' as string | null,
  collections: [] as CollectionRow[],
  items: [] as ItemRow[],
  failDb: false,
  dbCalls: 0,
  collectionWheres: [] as unknown[],
  itemWheres: [] as unknown[],
}));
const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  getSession: vi.fn(),
  searchMusic: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
  searchFeaturedTracks: vi.fn(),
}));

function project(row: Row, select: Row | undefined): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, value] of Object.entries(select)) if (value === true) out[key] = row[key];
  return out;
}

function comparable(value: unknown) {
  return value instanceof Date ? value.getTime() : (value as string | number);
}

function sortRows<T extends Row>(rows: T[], orderBy: unknown): T[] {
  const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<
    Record<string, 'asc' | 'desc'>
  >;
  return [...rows].sort((left, right) => {
    for (const order of orders) {
      const [key, direction] = Object.entries(order)[0] ?? [];
      if (!key) continue;
      const a = comparable(left[key]);
      const b = comparable(right[key]);
      if (a < b) return direction === 'asc' ? -1 : 1;
      if (a > b) return direction === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

function itemMatches(item: ItemRow, where: Where): boolean {
  if (!where) return true;
  const owner = (where.collection as { userId?: string } | undefined)?.userId;
  if (owner !== undefined) {
    const parent = memory.collections.find((collection) => collection.id === item.collectionId);
    if (parent?.userId !== owner) return false;
  }
  const ids = (where.id as { in?: string[] } | undefined)?.in;
  if (ids && !ids.includes(item.id)) return false;
  const title = where.title as { not?: null } | undefined;
  if (title && 'not' in title && title.not === null && item.title === null) return false;
  const artwork = where.artworkUrl as { not?: null } | undefined;
  if (artwork && 'not' in artwork && artwork.not === null && item.artworkUrl === null) return false;
  return true;
}

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    userMusicCollection: {
      findMany: vi.fn(
        async (args: { where?: Row; select?: Row; orderBy?: unknown; take?: number }) => {
          memory.dbCalls += 1;
          memory.collectionWheres.push(args.where);
          if (memory.failDb) throw new Error('db down');
          const userId = args.where?.userId as string | undefined;
          const ids = (args.where?.id as { in?: string[] } | undefined)?.in;
          const rows = sortRows(
            memory.collections.filter(
              (row) =>
                (userId === undefined || row.userId === userId) && (!ids || ids.includes(row.id)),
            ),
            args.orderBy,
          ).slice(0, args.take ?? Number.POSITIVE_INFINITY);
          return rows.map((row) => {
            const out = project(row, args.select);
            if (args.select?._count) {
              out._count = {
                items: memory.items.filter((item) => item.collectionId === row.id).length,
              };
            }
            const nested = args.select?.items as
              | { where?: Row; select?: Row; orderBy?: unknown; take?: number }
              | undefined;
            if (nested) {
              out.items = sortRows(
                memory.items.filter(
                  (item) => item.collectionId === row.id && itemMatches(item, nested.where),
                ),
                nested.orderBy,
              )
                .slice(0, nested.take ?? Number.POSITIVE_INFINITY)
                .map((item) => project(item, nested.select));
            }
            return out;
          });
        },
      ),
    },
    userMusicCollectionItem: {
      findMany: vi.fn(
        async (args: { where?: Row; select?: Row; orderBy?: unknown; take?: number }) => {
          memory.dbCalls += 1;
          memory.itemWheres.push(args.where);
          if (memory.failDb) throw new Error('db down');
          return sortRows(
            memory.items.filter((item) => itemMatches(item, args.where)),
            args.orderBy,
          )
            .slice(0, args.take ?? Number.POSITIVE_INFINITY)
            .map((item) => project(item, args.select));
        },
      ),
    },
  },
}));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!memory.userId) throw Response.json({ error: 'Unauthorized' }, { status: 401 });
    return { id: memory.userId, email: `${memory.userId}@example.test` };
  }),
}));
// Stessa regola di identità del modulo vero: l'utente autenticato, altrimenti l'IP d'ingresso.
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null, headers: Headers) =>
    userId ? `user:${userId}` : headers.get('x-real-ip') ? `ip:${headers.get('x-real-ip')}` : null,
}));
// Solo per search-all (la ricerca pubblica): fonti e sessione.
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/music/music-api.server', () => ({ searchMusic: mocks.searchMusic }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));
vi.mock('@/lib/music/featured-search.server', () => ({
  searchFeaturedTracks: mocks.searchFeaturedTracks,
}));

import { GET } from '@/app/api/music/library/search/route';
import { GET as searchAll } from '@/app/api/music/search-all/route';
import {
  LIBRARY_SEARCH_COLLECTION_LIMIT,
  LIBRARY_SEARCH_TRACK_LIMIT,
  LibrarySearchResponseSchema,
} from '@/lib/contracts/library-search';
import { UnifiedSearchResponseSchema } from '@/lib/contracts/unified-search';

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.parse('2026-11-01T10:00:00.000Z');
let clock = 0;

function addCollection(
  id: string,
  userId: string,
  name: string,
  extra: Partial<CollectionRow> = {},
): CollectionRow {
  const row: CollectionRow = {
    id,
    userId,
    name,
    kind: 'playlist',
    description: null,
    createdAt: new Date(t0 + ++clock * 1000),
    ...extra,
  };
  memory.collections.push(row);
  return row;
}

function addAudius(
  id: string,
  collectionId: string,
  title: string,
  extra: Partial<ItemRow> = {},
): ItemRow {
  const row: ItemRow = {
    id,
    collectionId,
    source: 'audius',
    sourceId: `trk-${id}`,
    title,
    creatorName: 'Artista',
    artworkUrl: `https://audius.co/images/${id}.jpg`,
    sourceUrl: `https://audius.co/artista/${id}`,
    artistUrl: 'https://audius.co/artista',
    durationSeconds: 200,
    createdAt: new Date(t0 + ++clock * 1000),
    expiresAt: null,
    ...extra,
  };
  memory.items.push(row);
  return row;
}

function addYouTube(
  id: string,
  collectionId: string,
  title: string,
  expiresAt: Date,
  extra: Partial<ItemRow> = {},
): ItemRow {
  const videoId = `${id}xxxxxxxxxxx`.slice(0, 11);
  return addAudius(id, collectionId, title, {
    source: 'youtube',
    sourceId: videoId,
    creatorName: 'Canale',
    artworkUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    artistUrl: null,
    durationSeconds: null,
    expiresAt,
    ...extra,
  });
}

function request(query: string | null) {
  const url = new URL('https://solco.test/api/music/library/search');
  if (query !== null) url.searchParams.set('q', query);
  return GET(new Request(url, { headers: { cookie: 'session=abc', 'x-real-ip': '192.0.2.9' } }));
}

async function search(query: string) {
  const response = await request(query);
  expect(response.status).toBe(200);
  return LibrarySearchResponseSchema.parse(await response.json());
}

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

beforeEach(() => {
  memory.userId = 'account-a';
  memory.collections = [];
  memory.items = [];
  memory.failDb = false;
  memory.dbCalls = 0;
  memory.collectionWheres = [];
  memory.itemWheres = [];
  clock = 0;
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
});

describe('GET /api/music/library/search: accesso e intestazioni', () => {
  it('senza sessione risponde 401 privato, senza leggere il DB né consumare il limite', async () => {
    memory.userId = null;
    addCollection('pl-a', 'account-a', 'Viaggio');
    const response = await request('viaggio');

    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(memory.dbCalls).toBe(0);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('Viaggio');
  });

  it('valida la query come search-all (spazi tolti, da 1 a 80 caratteri), con 400 privato', async () => {
    for (const query of [null, '', '    ', 'x'.repeat(81)]) {
      const response = await request(query);
      expect(response.status).toBe(400);
      expectPrivate(response);
      expect((await response.json()).errors.q).toContain('1 a 80');
    }
    expect(memory.dbCalls).toBe(0);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();

    // Esattamente 80 caratteri (dopo aver tolto gli spazi) va bene.
    const ok = await request(`  ${'a'.repeat(80)}  `);
    expect(ok.status).toBe(200);
    expect((await ok.json()).query).toBe('a'.repeat(80));
  });

  it('risposta 200 privata: Cache-Control private, no-store e Vary: Cookie', async () => {
    addCollection('pl-a', 'account-a', 'Viaggio');
    const response = await request('viaggio');
    expect(response.status).toBe(200);
    expectPrivate(response);
  });

  it('un errore del DB risponde 503 privato, senza dettagli', async () => {
    memory.failDb = true;
    const response = await request('viaggio');
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'library_search_unavailable' });
  });
});

describe('GET /api/music/library/search: limite condiviso con search-all', () => {
  it('usa il bucket music.search con la stessa identità di search-all, e un 429 resta privato', async () => {
    addCollection('pl-a', 'account-a', 'Ambient');
    mocks.getSession.mockResolvedValue({ user: { id: 'account-a' } });
    mocks.searchMusic.mockResolvedValue({
      outcome: 'no_results',
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      videos: [],
    });
    mocks.listStations.mockResolvedValue({ outcome: 'no_results', stations: [] });
    mocks.searchPodcasts.mockResolvedValue({ outcome: 'no_results', podcasts: [] });

    await request('ambient');
    await searchAll(
      new Request('https://solco.test/api/music/search-all?q=ambient', {
        headers: { cookie: 'session=abc', 'x-real-ip': '192.0.2.9' },
      }),
    );
    // Un solo bucket e una sola identità per le due richieste: nessun limite nuovo.
    expect(mocks.enforceRateLimit.mock.calls).toEqual([
      ['music.search', 'user:account-a'],
      ['music.search', 'user:account-a'],
    ]);

    mocks.enforceRateLimit.mockResolvedValue(
      Response.json(
        { error: 'rate_limited', retryAfterSeconds: 5 },
        { status: 429, headers: { 'Retry-After': '5' } },
      ),
    );
    memory.dbCalls = 0;
    const limited = await request('ambient');
    expect(limited.status).toBe(429);
    expectPrivate(limited);
    expect(limited.headers.get('retry-after')).toBe('5');
    expect(memory.dbCalls).toBe(0);
  });
});

describe('GET /api/music/library/search: solo le righe di chi chiama', () => {
  it('le playlist e i brani di un secondo utente non compaiono mai, anche se corrispondono', async () => {
    const mine = addCollection('pl-mine', 'account-a', 'Notte in città');
    addCollection('fav-a', 'account-a', 'Preferiti', { kind: 'favorites' });
    const theirs = addCollection('pl-theirs', 'account-b', 'Notte segreta di B', {
      description: 'Notte privata',
    });
    addCollection('fav-b', 'account-b', 'Preferiti', { kind: 'favorites' });
    addAudius('i-mine', mine.id, 'Notte stellata');
    addAudius('i-theirs', theirs.id, 'Notte di B', { creatorName: 'Segreto' });
    addAudius('i-theirs-fav', 'fav-b', 'Notte nei Preferiti di B', { sourceId: 'fav-b-track' });

    const body = await search('notte');
    expect(body.collections.map((collection) => collection.id)).toEqual(['pl-mine']);
    expect(body.tracks.map((track) => track.id)).toEqual(['i-mine']);
    const raw = JSON.stringify(body);
    for (const leak of ['account-b', 'pl-theirs', 'fav-b', 'segreta', 'Segreto', 'di B']) {
      expect(raw).not.toContain(leak);
    }

    // Ogni lettura del DB porta il filtro per l'utente che chiama.
    for (const where of memory.collectionWheres)
      expect(where).toMatchObject({ userId: 'account-a' });
    for (const where of memory.itemWheres) {
      expect(where).toMatchObject({ collection: { userId: 'account-a' } });
    }

    // Il secondo utente vede solo le sue.
    memory.userId = 'account-b';
    const other = await search('notte');
    expect(other.collections.map((collection) => collection.id)).toEqual(['pl-theirs']);
    expect(other.tracks.map((track) => track.id).sort()).toEqual(['i-theirs', 'i-theirs-fav']);
  });

  it('i Preferiti e le playlist: badge di tipo, descrizione (solo playlist), conteggio, copertine', async () => {
    const fav = addCollection('fav-a', 'account-a', 'Preferiti', {
      kind: 'favorites',
      description: 'non mostrata',
    });
    const road = addCollection('pl-road', 'account-a', 'Viaggio', {
      description: '  Brani per la strada.  ',
    });
    // Ordine della Libreria: più recenti prima. 5 copertine diverse + una ripetuta → 4 nel mosaico.
    for (const index of [1, 2, 3, 4, 5]) addAudius(`r${index}`, road.id, `Strada ${index}`);
    addAudius('r6', road.id, 'Strada copia', { artworkUrl: 'https://audius.co/images/r5.jpg' });
    addAudius('r7', road.id, 'Senza copertina', { artworkUrl: null });
    addAudius('f1', fav.id, 'Preferito');

    const preferiti = await search('preferiti');
    expect(preferiti.collections).toEqual([
      {
        id: 'fav-a',
        name: 'Preferiti',
        kind: 'favorites',
        description: null,
        itemCount: 1,
        covers: ['https://audius.co/images/f1.jpg'],
      },
    ]);

    const viaggio = await search('VIAGGIO');
    expect(viaggio.collections).toEqual([
      {
        id: 'pl-road',
        name: 'Viaggio',
        kind: 'playlist',
        description: 'Brani per la strada.',
        itemCount: 7,
        covers: [
          'https://audius.co/images/r5.jpg',
          'https://audius.co/images/r4.jpg',
          'https://audius.co/images/r3.jpg',
          'https://audius.co/images/r2.jpg',
        ],
      },
    ]);

    // La descrizione conta (sotto il nome): «strada» trova la playlist e i brani «Strada …».
    const strada = await search('strada');
    expect(strada.collections.map((collection) => collection.id)).toEqual(['pl-road']);
  });
});

describe('GET /api/music/library/search: confronto e tetti', () => {
  it('non distingue maiuscole e accenti, in entrambe le direzioni', async () => {
    const pl = addCollection('pl-why', 'account-a', 'PERCHÉ NO');
    addAudius('i-why', pl.id, 'Perché', { creatorName: 'Ligabue' });
    addAudius('i-cafe', pl.id, 'Caffe nero', { creatorName: 'Città Vuota' });
    addAudius('i-other', pl.id, 'Altro brano', { creatorName: 'Nessuno' });

    const plain = await search('perche');
    expect(plain.collections.map((collection) => collection.name)).toEqual(['PERCHÉ NO']);
    expect(plain.tracks.map((track) => track.title)).toEqual(['Perché']);

    const accented = await search('CAFFÈ');
    expect(accented.tracks.map((track) => track.title)).toEqual(['Caffe nero']);

    // Anche l'artista: «citta» trova «Città Vuota».
    const byArtist = await search('citta');
    expect(byArtist.tracks.map((track) => track.id)).toEqual(['i-cafe']);
  });

  it('trova un brano anche con «Artista Titolo» e «Artista - Titolo» (la query dei link di condivisione)', async () => {
    const pl = addCollection('pl-it', 'account-a', 'Italiana');
    addAudius('why', pl.id, 'Perché', { creatorName: 'Ligabue' });
    addAudius('alba', pl.id, 'Albachiara', { creatorName: 'Vasco Rossi' });
    addAudius('anon', pl.id, 'Senza artista', { creatorName: null });

    // Ordine titolo-artista (c'era già) e artista-titolo, anche col trattino e senza accenti.
    for (const query of [
      'perche ligabue',
      'ligabue perche',
      'Ligabue - Perché',
      'LIGABUE – PERCHE',
    ]) {
      const body = await search(query);
      expect(
        body.tracks.map((track) => track.id),
        query,
      ).toEqual(['why']);
    }
    // Il formato esatto di songShareUrl ("artista titolo") vale quanto un titolo uguale.
    expect((await search('vasco rossi albachiara')).tracks.map((track) => track.id)).toEqual([
      'alba',
    ]);
    // Nessun artista predefinito (a differenza dei brani in evidenza, «Solco»): niente corrispondenze
    // inventate per un brano senza artista.
    expect((await search('solco senza artista')).tracks).toEqual([]);
    expect((await search('senza artista')).tracks.map((track) => track.id)).toEqual(['anon']);
    // Le parti non si mescolano: l'artista di un brano col titolo di un altro non trova nulla.
    expect((await search('ligabue albachiara')).tracks).toEqual([]);
  });

  it('trackRelevance: «Artista Titolo» uguale vale 100, come featuredRelevance senza «Solco»', async () => {
    const { featuredRelevance, trackRelevance } = await import('@/lib/music/unified-search');
    const track = { title: 'Perché', artist: 'Ligabue' };
    expect(trackRelevance(track, 'ligabue perche')).toBe(100);
    expect(trackRelevance(track, 'Ligabue - Perché')).toBe(100);
    expect(trackRelevance(track, 'ligabue per')).toBe(70);
    expect(trackRelevance(track, 'perche')).toBe(100);
    expect(trackRelevance(track, 'albachiara')).toBe(0);
    // Con un artista, identica a featuredRelevance; senza, nessun «Solco» implicito.
    expect(trackRelevance(track, 'ligabue perche')).toBe(
      featuredRelevance(track, 'ligabue perche'),
    );
    expect(trackRelevance({ title: 'Luna', artist: null }, 'solco luna')).toBe(0);
    expect(featuredRelevance({ title: 'Luna', artist: null }, 'solco luna')).toBe(100);
  });

  it('ordina per rilevanza (uguale > inizia con > contiene) e restituisce i campi per il player', async () => {
    const pl = addCollection('pl-1', 'account-a', 'Mix');
    addAudius('contains', pl.id, 'La mia luna piena');
    addAudius('starts', pl.id, 'Luna rossa');
    addAudius('equal', pl.id, 'Luna');

    const body = await search('luna');
    expect(body.tracks.map((track) => track.id)).toEqual(['equal', 'starts', 'contains']);
    expect(body.tracks[0]).toEqual({
      id: 'equal',
      source: 'audius',
      sourceId: 'trk-equal',
      title: 'Luna',
      creatorName: 'Artista',
      artworkUrl: 'https://audius.co/images/equal.jpg',
      sourceUrl: 'https://audius.co/artista/equal',
      artistUrl: 'https://audius.co/artista',
      durationSeconds: 200,
      collectionId: 'pl-1',
      collectionName: 'Mix',
      collectionKind: 'playlist',
      otherCollectionCount: 0,
    });
  });

  it('un brano in più raccolte compare una volta, con il conteggio delle altre', async () => {
    const fav = addCollection('fav-a', 'account-a', 'Preferiti', { kind: 'favorites' });
    const one = addCollection('pl-1', 'account-a', 'Uno');
    const two = addCollection('pl-2', 'account-a', 'Due');
    addAudius('in-one', one.id, 'Volare', { sourceId: 'same' });
    addAudius('in-two', two.id, 'Volare', { sourceId: 'same' });
    addAudius('in-fav', fav.id, 'Volare', { sourceId: 'same' });

    const body = await search('volare');
    expect(body.tracks).toHaveLength(1);
    // A parità di rilevanza resta l'aggiunta più recente (i Preferiti, qui).
    expect(body.tracks[0]).toMatchObject({
      id: 'in-fav',
      collectionKind: 'favorites',
      otherCollectionCount: 2,
    });
  });

  it(`al massimo ${LIBRARY_SEARCH_COLLECTION_LIMIT} raccolte e ${LIBRARY_SEARCH_TRACK_LIMIT} brani`, async () => {
    for (let index = 0; index < 9; index += 1) {
      const pl = addCollection(`pl-${index}`, 'account-a', `Estate ${index}`);
      addAudius(`a-${index}`, pl.id, `Estate brano ${index}`);
      addAudius(`b-${index}`, pl.id, `Estate altro ${index}`);
    }
    const body = await search('estate');
    expect(body.collections).toHaveLength(LIBRARY_SEARCH_COLLECTION_LIMIT);
    expect(body.tracks).toHaveLength(LIBRARY_SEARCH_TRACK_LIMIT);
    // A parità di rilevanza: raccolte nell'ordine della Libreria, brani dai più recenti.
    expect(body.collections[0]?.id).toBe('pl-0');
    expect(body.tracks[0]?.id).toBe('b-8');
  });
});

describe('GET /api/music/library/search: conservazione dei metadati YouTube', () => {
  it('un video oltre la scadenza non corrisponde, non dà la copertina e non torna nei brani', async () => {
    const pl = addCollection('pl-yt', 'account-a', 'Video');
    const now = Date.now();
    // Scaduto ma non ancora ripulito nel DB (nessuna scrittura è passata): titolo ancora presente.
    addYouTube('old', pl.id, 'Tramonto scaduto', new Date(now - DAY));
    addYouTube('new', pl.id, 'Tramonto valido', new Date(now + 10 * DAY));

    const body = await search('tramonto');
    expect(body.tracks.map((track) => track.id)).toEqual(['new']);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('scaduto');
    expect(raw).not.toContain('oldxxxxxxxx');

    // Il mosaico della raccolta usa solo la copertina del video ancora valido.
    const video = await search('video');
    expect(video.collections[0]?.covers).toEqual([
      'https://i.ytimg.com/vi/newxxxxxxxx/mqdefault.jpg',
    ]);
    // Il video scaduto conta ancora fra gli elementi, come nella Libreria.
    expect(video.collections[0]?.itemCount).toBe(2);
  });

  it('un video con i metadati già rimossi (titolo null) non viene nemmeno letto per il confronto', async () => {
    const pl = addCollection('pl-yt', 'account-a', 'Video');
    addYouTube('gone', pl.id, 'x', new Date(Date.now() - DAY), {
      title: null,
      creatorName: null,
      artworkUrl: null,
      sourceUrl: null,
      expiresAt: null,
    });
    const body = await search('xxxxxxxx');
    expect(body.tracks).toEqual([]);
    expect(memory.itemWheres[0]).toMatchObject({ title: { not: null } });
  });
});

describe('GET /api/music/search-all resta pubblico', () => {
  it('con la sessione non legge la Libreria e la risposta non porta dati dell’utente', async () => {
    addCollection('pl-a', 'account-a', 'Ambient notturno', { description: 'Solo mia' });
    addAudius('i-a', 'pl-a', 'Ambient segreto');
    mocks.getSession.mockResolvedValue({ user: { id: 'account-a' } });
    mocks.searchMusic.mockResolvedValue({
      outcome: 'no_results',
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      videos: [],
    });
    mocks.listStations.mockResolvedValue({
      outcome: 'results',
      stations: [
        {
          id: 's1',
          name: 'Ambient FM',
          artworkUrl: null,
          country: 'Italy',
          countryCode: 'IT',
          tags: [],
          codec: 'MP3',
          bitrate: 128,
          homepage: null,
          votes: 1,
        },
      ],
    });
    mocks.searchPodcasts.mockResolvedValue({ outcome: 'no_results', podcasts: [] });

    const response = await searchAll(
      new Request('https://solco.test/api/music/search-all?q=ambient', {
        headers: { cookie: 'session=abc', 'x-real-ip': '192.0.2.9' },
      }),
    );
    const raw = await response.json();
    const body = UnifiedSearchResponseSchema.parse(raw);

    expect(memory.dbCalls).toBe(0);
    expect(Object.keys(raw).sort()).toEqual(['query', 'results', 'sources', 'youtubeRequested']);
    expect(Object.keys(raw.sources).sort()).toEqual(['audius', 'podcasts', 'radio', 'youtube']);
    expect(body.results.map((result) => result.kind)).toEqual(['radio']);
    const text = JSON.stringify(raw);
    for (const leak of ['notturno', 'Solo mia', 'segreto', 'pl-a', 'account-a']) {
      expect(text).not.toContain(leak);
    }
    // Sempre cacheabile in CDN come prima: la sessione non cambia la cache.
    expect(response.headers.get('cache-control')).toContain('s-maxage');
  });
});
