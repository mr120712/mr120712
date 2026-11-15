// @polsia:user-owned — «In evidenza da audio.com» lato server: le collection dell'account collegato
// (elenco per l'admin, scelta salvata in ordine) diventano sezioni della Home con le regole della
// ricerca (stream solo CC0/BY/BY-SA/BY-ND e mai cover, solo brani musicali pubblici, al massimo 50),
// in cache (una sola costruzione per richieste contemporanee), con le ultime sezioni buone se
// audio.com non risponde (al più un'ora) e niente senza account. Route admin: solo admin, stessa
// origine sul PUT, scelta validata (al massimo 6, senza ripetizioni, solo collection dell'account).
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => {
  const rows: Array<{ collectionId: string; position: number }> = [];
  return {
    rows,
    findMany: vi.fn(async () => [...rows].sort((a, b) => a.position - b.position)),
    deleteMany: vi.fn(async () => {
      rows.length = 0;
      return { count: 0 };
    }),
    createMany: vi.fn(async (args: { data: Array<{ collectionId: string; position: number }> }) => {
      rows.push(...args.data.map(({ collectionId, position }) => ({ collectionId, position })));
      return { count: args.data.length };
    }),
    transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    consumeRateLimit: vi.fn(async () => ({ allowed: true })),
    getAccess: vi.fn(),
    request: vi.fn(),
    markRejected: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
    requireAdmin: vi.fn(),
    sameOrigin: vi.fn(() => true),
  };
});

vi.mock('@/lib/db', () => ({
  prisma: {
    audioComFeaturedCollection: {
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
      createMany: mocks.createMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/music/audiocom-connection.server', () => ({
  AUDIOCOM_API_ORIGIN: 'https://api.audio.com',
  AudioComError: class AudioComError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
  audioComRequest: mocks.request,
  getAudioComAccessToken: mocks.getAccess,
  markAudioComAccessRejected: mocks.markRejected,
  recordAudioComError: mocks.recordError,
}));
vi.mock('@/lib/music/audiocom-admin.server', () => ({
  audioComPrivateHeaders: { 'Cache-Control': 'private, no-store' },
  requireAudioComAdmin: mocks.requireAdmin,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));

import { GET as adminGet, PUT as adminPut } from '@/app/api/admin/audiocom/collections/route';
import { GET as homeGet } from '@/app/api/music/audiocom/featured/route';
import {
  AudioComCollectionsAdminResponseSchema,
  AudioComHomeResponseSchema,
} from '@/lib/contracts/audiocom-collections';
import {
  AUDIOCOM_SECTIONS_STALE_MAX_MS,
  AUDIOCOM_SECTIONS_TTL_MS,
  clearAudioComSectionsCache,
  getAudioComHomeSections,
  parseAudioComCollectionItems,
  parseAudioComCollectionList,
} from '@/lib/music/audiocom-collections.server';

function audio(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Brano ${id}`,
    slug: `brano-${id}`,
    username: 'artista',
    author_name: 'Artista',
    category: 'music',
    license: 'cc-by',
    is_listed: true,
    image: `https://img.audio.com/${id}.jpg`,
    play: { url: `https://s3.audio.com/audio/${id}.mp3`, duration: 180_000 },
    ...extra,
  };
}

function collection(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Raccolta ${id}`,
    type: 'playlist',
    items_count: 2,
    is_listed: true,
    image: `https://img.audio.com/c${id}.jpg`,
    ...extra,
  };
}

type Reply = { status?: number; body: unknown };
/** Risposte di audio.com per URL: view e items di ogni collection, list dell'account. */
function serve(replies: Record<string, Reply>) {
  mocks.request.mockImplementation(async (url: string) => {
    const parsed = new URL(url);
    const key = `${parsed.pathname}${parsed.searchParams.get('id') ? `?id=${parsed.searchParams.get('id')}` : ''}`;
    const reply = replies[key] ?? { status: 404, body: null };
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, headers: new Headers(), body: reply.body };
  });
}

function featured(...ids: string[]) {
  mocks.rows.length = 0;
  ids.forEach((collectionId, position) => {
    mocks.rows.push({ collectionId, position });
  });
}

beforeEach(() => {
  clearAudioComSectionsCache();
  mocks.rows.length = 0;
  for (const fn of [
    mocks.findMany,
    mocks.deleteMany,
    mocks.createMany,
    mocks.transaction,
    mocks.request,
    mocks.markRejected,
    mocks.recordError,
    mocks.consumeRateLimit,
    mocks.sameOrigin,
  ]) {
    fn.mockClear();
  }
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getAccess.mockReset();
  mocks.getAccess.mockResolvedValue({ ok: true, token: 'tok', version: 1 });
  mocks.requireAdmin.mockReset();
  mocks.requireAdmin.mockResolvedValue({ allowed: true, userId: 'admin-1' });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lettura delle collection e dei brani', () => {
  it('elenco: id e titolo validi, senza ripetizioni, copertine solo audio.com, scelte segnate', () => {
    const list = parseAudioComCollectionList(
      [
        collection('10'),
        collection('10'),
        collection('11', { image: 'https://evil.example/x.jpg', is_listed: false }),
        collection('abc'),
        collection('12', { title: '   ' }),
      ],
      new Set(['11']),
    );
    expect(list?.map((item) => [item.id, item.featured, item.listed, item.imageUrl])).toEqual([
      ['10', false, true, 'https://img.audio.com/c10.jpg'],
      ['11', true, false, null],
    ]);
    expect(parseAudioComCollectionList({ items: [] }, new Set())).toBeNull();
  });

  it('brani: stream solo con licenza ammessa e mai per le cover; solo musica pubblica; ordine tenuto', () => {
    const tracks = parseAudioComCollectionItems([
      audio('1'),
      audio('2', { license: 'arr' }),
      audio('3', { category: 'cover', license: 'cc-by' }),
      audio('4', { category: 'podcast' }),
      audio('5', { is_listed: false }),
      audio('6', { license: 'cc-by-nc' }),
      audio('1'),
    ]);
    expect(tracks?.map((track) => [track.id, track.streamUrl !== null])).toEqual([
      ['1', true],
      ['2', false],
      ['3', false],
      ['6', false],
    ]);
    expect(parseAudioComCollectionItems('nope')).toBeNull();
  });

  it('al massimo 50 brani per sezione', () => {
    const many = Array.from({ length: 60 }, (_, index) => audio(String(index + 1)));
    expect(parseAudioComCollectionItems(many)).toHaveLength(50);
  });
});

describe('sezioni della Home', () => {
  const twoCollections = () => {
    featured('20', '10');
    serve({
      '/v1/collection/view?id=10': { body: collection('10') },
      '/v1/collection/items?id=10': { body: [audio('1'), audio('2', { license: 'arr' })] },
      '/v1/collection/view?id=20': { body: collection('20', { title: 'Novità' }) },
      '/v1/collection/items?id=20': { body: [audio('3')] },
    });
  };

  it('una sezione per collection, nell’ordine scelto, con titolo, copertina e brani', async () => {
    twoCollections();
    const sections = await getAudioComHomeSections();
    expect(sections.map((section) => [section.id, section.title, section.tracks.length])).toEqual([
      ['20', 'Novità', 1],
      ['10', 'Raccolta 10', 2],
    ]);
    // Ogni richiesta consuma il limite globale condiviso con la ricerca.
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(4);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('audiocom.search.global', 'global');
  });

  it('in cache: richieste contemporanee e successive non richiamano audio.com', async () => {
    twoCollections();
    const [first, second] = await Promise.all([
      getAudioComHomeSections(),
      getAudioComHomeSections(),
    ]);
    expect(first).toEqual(second);
    await getAudioComHomeSections();
    expect(mocks.request).toHaveBeenCalledTimes(4);
    clearAudioComSectionsCache();
    await getAudioComHomeSections();
    expect(mocks.request).toHaveBeenCalledTimes(8);
  });

  it('collection cancellata o senza brani musicali: si salta, le altre restano', async () => {
    featured('30', '31', '10');
    serve({
      '/v1/collection/view?id=31': { body: collection('31') },
      '/v1/collection/items?id=31': { body: [audio('9', { category: 'podcast' })] },
      '/v1/collection/view?id=10': { body: collection('10') },
      '/v1/collection/items?id=10': { body: [audio('1')] },
    });
    const sections = await getAudioComHomeSections();
    expect(sections.map((section) => section.id)).toEqual(['10']);
  });

  it('nessuna scelta o nessun account collegato: nessuna sezione, nessuna richiesta', async () => {
    expect(await getAudioComHomeSections()).toEqual([]);
    featured('10');
    clearAudioComSectionsCache();
    mocks.getAccess.mockResolvedValue({ ok: false, reason: 'disconnected' });
    expect(await getAudioComHomeSections()).toEqual([]);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('audio.com non risponde: le ultime sezioni buone, al più per un’ora', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-11-15T10:00:00.000Z').getTime();
    vi.setSystemTime(start);
    twoCollections();
    const good = await getAudioComHomeSections();
    expect(good).toHaveLength(2);

    // Dopo la scadenza audio.com dà errore: si servono le sezioni di prima.
    vi.setSystemTime(start + AUDIOCOM_SECTIONS_TTL_MS + 1);
    serve({ '/v1/collection/view?id=20': { status: 500, body: null } });
    expect(await getAudioComHomeSections()).toEqual(good);

    // Oltre un'ora dall'ultima costruzione riuscita: più niente (la Home resta senza sezioni).
    vi.setSystemTime(start + AUDIOCOM_SECTIONS_STALE_MAX_MS + 1);
    expect(await getAudioComHomeSections()).toEqual([]);
  });

  it('token rifiutato: si segnala per il rinnovo e la Home non si rompe', async () => {
    featured('10');
    serve({ '/v1/collection/view?id=10': { status: 401, body: null } });
    expect(await getAudioComHomeSections()).toEqual([]);
    expect(mocks.markRejected).toHaveBeenCalledWith(1);
  });

  it('limite globale esaurito: nessuna richiesta ad audio.com', async () => {
    featured('10');
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false });
    expect(await getAudioComHomeSections()).toEqual([]);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe('GET /api/music/audiocom/featured', () => {
  it('le sezioni nel formato del contratto, in cache nella rete per poco', async () => {
    featured('10');
    serve({
      '/v1/collection/view?id=10': { body: collection('10') },
      '/v1/collection/items?id=10': { body: [audio('1')] },
    });
    const response = await homeGet();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('s-maxage=120');
    const body = AudioComHomeResponseSchema.parse(await response.json());
    expect(body.sections[0]?.tracks[0]?.streamUrl).toBe('https://s3.audio.com/audio/1.mp3');
  });

  it('senza sezioni: elenco vuoto, mai un errore', async () => {
    const response = await homeGet();
    expect(await response.json()).toEqual({ sections: [] });
  });
});

describe('/api/admin/audiocom/collections', () => {
  const request = (method: string, body?: unknown) =>
    new Request('https://www.solcomusic.online/api/admin/audiocom/collections', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const account = () =>
    serve({
      '/v1/collection/list': { body: [collection('10'), collection('11'), collection('12')] },
    });

  it('GET: le collection dell’account con quelle in Home', async () => {
    featured('11');
    account();
    const response = await adminGet(request('GET'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = AudioComCollectionsAdminResponseSchema.parse(await response.json());
    expect(body.status).toBe('ok');
    expect(body.featuredIds).toEqual(['11']);
    expect(body.collections.filter((item) => item.featured).map((item) => item.id)).toEqual(['11']);
  });

  it('GET senza account collegato: disconnected, con la scelta salvata', async () => {
    featured('11');
    mocks.getAccess.mockResolvedValue({ ok: false, reason: 'disconnected' });
    const body = AudioComCollectionsAdminResponseSchema.parse(
      await (await adminGet(request('GET'))).json(),
    );
    expect(body).toMatchObject({ status: 'disconnected', collections: [], featuredIds: ['11'] });
  });

  it('solo amministratori', async () => {
    mocks.requireAdmin.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: 'forbidden' }, { status: 403 }),
    });
    expect((await adminGet(request('GET'))).status).toBe(403);
    expect((await adminPut(request('PUT', { collectionIds: [] }))).status).toBe(403);
  });

  it('PUT: salva nell’ordine e svuota la cache delle sezioni', async () => {
    account();
    // Una sezione già in cache con la scelta vecchia.
    featured('10');
    serve({
      '/v1/collection/list': { body: [collection('10'), collection('11'), collection('12')] },
      '/v1/collection/view?id=10': { body: collection('10') },
      '/v1/collection/items?id=10': { body: [audio('1')] },
      '/v1/collection/view?id=12': { body: collection('12') },
      '/v1/collection/items?id=12': { body: [audio('2')] },
    });
    expect((await getAudioComHomeSections()).map((section) => section.id)).toEqual(['10']);

    const response = await adminPut(request('PUT', { collectionIds: ['12', '10'] }));
    expect(response.status).toBe(200);
    const body = AudioComCollectionsAdminResponseSchema.parse(await response.json());
    expect(body.featuredIds).toEqual(['12', '10']);
    expect(mocks.rows).toEqual([
      { collectionId: '12', position: 0 },
      { collectionId: '10', position: 1 },
    ]);
    expect((await getAudioComHomeSections()).map((section) => section.id)).toEqual(['12', '10']);
  });

  it('PUT: altra origine 403; scelta non valida 400 con il motivo; collection non dell’account 400', async () => {
    account();
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await adminPut(request('PUT', { collectionIds: ['10'] }))).status).toBe(403);

    for (const body of [
      { collectionIds: ['10', '10'] },
      { collectionIds: ['1', '2', '3', '4', '5', '6', '7'] },
      { collectionIds: ['abc'] },
      { collectionIds: ['10'], altro: true },
    ]) {
      const response = await adminPut(request('PUT', body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        errors: { collectionIds: expect.any(String) },
      });
    }

    const foreign = await adminPut(request('PUT', { collectionIds: ['99'] }));
    expect(foreign.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('PUT senza account o con audio.com giù: 503, niente salvato', async () => {
    mocks.getAccess.mockResolvedValue({ ok: false, reason: 'disconnected' });
    const response = await adminPut(request('PUT', { collectionIds: ['10'] }));
    expect(response.status).toBe(503);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
