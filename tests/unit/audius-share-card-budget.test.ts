// @polsia:user-owned — scheda di un brano Audius condiviso con il client Audius vero: una sola
// richiesta ad Audius e un solo posto del budget mensile per lettura (anche per un id inesistente,
// anche dopo la scadenza), mai un giro su tutti gli host; un 429 di Audius allunga comunque
// l'attesa condivisa dell'intera app.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  reserve: vi.fn(),
  budget: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { audiusRequestBudget: mocks.budget } }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: () => ({ active: true, apiKey: 'chiave-di-prova', blockers: [] }),
}));
// Client Audius vero; solo la prenotazione del budget condiviso (database) è finta.
vi.mock('@/lib/music/audius-api.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/audius-api.server')>()),
  reserveAudiusRequestSlot: mocks.reserve,
}));

import { clearAudiusMetadataCacheForTests } from '@/lib/music/audius-api.server';
import {
  clearAudiusShareCardCacheForTests,
  getAudiusShareCard,
} from '@/lib/music/audius-share-card.server';

let fetched: string[] = [];
let respond: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  clearAudiusShareCardCacheForTests();
  clearAudiusMetadataCacheForTests();
  mocks.consumeRateLimit.mockReset().mockResolvedValue({ allowed: true });
  mocks.reserve.mockReset().mockImplementation(async () => ({
    allowed: true,
    notBefore: Date.now(),
  }));
  mocks.budget.findUnique.mockReset().mockResolvedValue({
    id: 'global',
    monthKey: '2026-11',
    requestCount: 10,
    nextRequestAt: new Date(0),
  });
  mocks.budget.updateMany.mockReset().mockResolvedValue({ count: 1 });
  fetched = [];
  respond = async () => new Response('{"data":null}', { status: 404 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return respond(url, init);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('una sola richiesta ad Audius per anteprima', () => {
  it('id inesistente (404): una richiesta e un posto del budget, nessun altro host', async () => {
    expect(await getAudiusShareCard('RandomId42', { identity: 'ip:203.0.113.7' })).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/v1/tracks/RandomId42?');
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    // Nessuna ricerca del registro degli host (api.audius.co).
    expect(fetched.some((url) => url.startsWith('https://api.audius.co'))).toBe(false);
    // Un attimo dopo nulla è cambiato: il ciclo sugli host non continua in sottofondo.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetched).toHaveLength(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });

  it('richiesta ferma: null alla scadenza e nessuna richiesta né prenotazione dopo', async () => {
    respond = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    const started = Date.now();
    expect(await getAudiusShareCard('Lento1', { timeoutMs: 60 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetched).toHaveLength(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });

  it('coda condivisa piena: nessuna richiesta ad Audius', async () => {
    mocks.reserve.mockResolvedValue({
      allowed: false,
      reason: 'rate_limited',
      retryAfterSeconds: 2,
    });
    expect(await getAudiusShareCard('Coda1')).toBeNull();
    expect(fetched).toEqual([]);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });

  it('429 di Audius: una sola richiesta, ma l’attesa chiesta vale per tutta l’app', async () => {
    respond = async () => new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    expect(await getAudiusShareCard('Limite1')).toBeNull();
    expect(fetched).toHaveLength(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.budget.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nextRequestAt: expect.any(Date) },
      }),
    );
  });

  it('brano trovato: una richiesta, titolo, artista e copertina da Audius', async () => {
    const cover =
      'https://audius-01.staked.cloud/content/QmCoverAbcdefghijklmnopqrstuv/480x480.jpg';
    respond = async () =>
      Response.json({
        data: {
          id: 'J7Xb000',
          title: 'Luci basse',
          permalink: '/artista/luci-basse',
          duration: 201,
          is_available: true,
          is_streamable: true,
          is_stream_gated: false,
          access: { stream: true, download: false },
          access_authorities: null,
          license: null,
          artwork: { '480x480': cover },
          user: { id: 'u1', handle: 'artista', name: 'Artista Audius' },
        },
      });
    expect(await getAudiusShareCard('J7Xb000')).toEqual({
      title: 'Luci basse',
      artist: 'Artista Audius',
      coverUrl: cover,
    });
    expect(fetched).toHaveLength(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });
});
