// @polsia:user-owned — pulizia giornaliera: cancella le trascrizioni IA conservate cifrate e non
// usate da 180 giorni (solo quelle, a lotti limitati), resta idempotente, lo scrive nel battito e,
// se questa pulizia fallisce, le altre continuano e il battito si salva lo stesso.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  recordHeartbeat: vi.fn(),
}));
// Le altre pulizie non interessano qui: rispondono "nulla da cancellare".
const { zero } = vi.hoisted(() => ({ zero: async () => ({ count: 0 }) }));

vi.mock('@/lib/db', () => ({
  prisma: {
    songResolution: { deleteMany: zero },
    youTubeSearchCache: { deleteMany: zero },
    actionRateLimit: { deleteMany: zero },
    aiMusicSearchCache: { deleteMany: zero },
    monitorRun: { deleteMany: zero },
    publicUploadPlay: { deleteMany: zero },
    siteVisit: { deleteMany: zero },
    lyricsTranscriptionCache: { findMany: mocks.findMany, deleteMany: mocks.deleteMany },
  },
}));
vi.mock('@/lib/music/collections.server', () => ({ expireYouTubeCollectionMetadata: zero }));
vi.mock('@/lib/music/song-resolve.server', () => ({ FOUND_TTL_MS: 28 * 86_400_000 }));
vi.mock('@/lib/music/youtube-budget.server', () => ({ deleteOldYouTubeQuotaUsage: zero }));
vi.mock('@/lib/music/youtube-chart-store.server', () => ({
  YOUTUBE_CHART_KEY_PREFIX: 'chart:',
  YOUTUBE_CHART_STALE_MS: 86_400_000,
}));
vi.mock('@/lib/music/youtube-history.server', () => ({ deleteExpiredYouTubeHistory: zero }));
vi.mock('@/lib/music/youtube-search-store.server', () => ({
  YOUTUBE_STORE_MAX_AGE_MS: 28 * 86_400_000,
}));
vi.mock('@/lib/monitoring/checks.server', () => ({ CLEANUP_HEARTBEAT: 'cleanup' }));
vi.mock('@/lib/monitoring/monitor.server', () => ({ recordHeartbeat: mocks.recordHeartbeat }));

import { GET } from '@/app/api/cron/cleanup/route';
import { TRANSCRIPTION_CACHE_PURGE_BATCH } from '@/lib/music/transcription-cache.server';

const CRON_SECRET = 'fake-cron-secret-0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;

type Row = { id: string; lastUsedAt: Date };
type FindArgs = { where: { lastUsedAt: { lt: Date } }; take: number; orderBy: unknown };
type DeleteArgs = { where: { id: { in: string[] }; lastUsedAt: { lt: Date } } };

function cron(authorization = `Bearer ${CRON_SECRET}`) {
  return GET(new Request('https://solco.test/api/cron/cleanup', { headers: { authorization } }));
}

/** Righe finte filtrate come farebbe Postgres. */
function fakeRows(now: number, idleDays: number[]) {
  let rows: Row[] = idleDays.map((days, index) => ({
    id: `t-${index}`,
    lastUsedAt: new Date(now - days * DAY),
  }));
  mocks.findMany.mockImplementation(async ({ where, take }: FindArgs) =>
    rows
      .filter((row) => row.lastUsedAt < where.lastUsedAt.lt)
      .sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime())
      .slice(0, take)
      .map((row) => ({ id: row.id })),
  );
  mocks.deleteMany.mockImplementation(async ({ where }: DeleteArgs) => {
    const before = rows.length;
    rows = rows.filter(
      (row) => !(where.id.in.includes(row.id) && row.lastUsedAt < where.lastUsedAt.lt),
    );
    return { count: before - rows.length };
  });
  return () => rows.map((row) => row.id);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  mocks.recordHeartbeat.mockResolvedValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/cron/cleanup: trascrizioni cifrate non usate', () => {
  it('senza il segreto del cron non cancella nulla', async () => {
    expect((await cron('Bearer nope')).status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('cancella solo le voci ferme da oltre 180 giorni, a lotti limitati; idempotente', async () => {
    const before = Date.now();
    const remaining = fakeRows(before, [0, 10, 179, 181, 365]);
    const first = await cron();
    expect(first.status).toBe(200);
    expect(remaining()).toEqual(['t-0', 't-1', 't-2']);

    const query = mocks.findMany.mock.calls[0]?.[0] as FindArgs;
    const cutoff = query.where.lastUsedAt.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(180 * DAY - 1000);
    expect(Date.now() - cutoff).toBeLessThanOrEqual(180 * DAY + 1000);
    expect(query.take).toBe(TRANSCRIPTION_CACHE_PURGE_BATCH);
    expect(query.orderBy).toEqual({ lastUsedAt: 'asc' });
    const removal = mocks.deleteMany.mock.calls[0]?.[0] as DeleteArgs;
    expect(Object.keys(removal.where).sort()).toEqual(['id', 'lastUsedAt']);
    expect(removal.where.lastUsedAt.lt.getTime()).toBe(cutoff);
    expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
      'cleanup',
      expect.stringContaining('2 trascrizioni cifrate non usate'),
    );
    expect((mocks.recordHeartbeat.mock.calls[0] as [string, string])[1].length).toBeLessThanOrEqual(
      300,
    );

    await cron();
    expect(remaining()).toEqual(['t-0', 't-1', 't-2']);
    // Nulla da cancellare: nessuna seconda cancellazione.
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.recordHeartbeat).toHaveBeenLastCalledWith(
      'cleanup',
      expect.stringContaining('0 trascrizioni cifrate non usate'),
    );
  });

  it('al massimo un lotto per esecuzione: le altre voci il giorno dopo', async () => {
    const now = Date.now();
    const remaining = fakeRows(
      now,
      Array.from({ length: TRANSCRIPTION_CACHE_PURGE_BATCH + 3 }, (_, index) => 200 + index),
    );
    await cron();
    expect(remaining()).toHaveLength(3);
    const removal = mocks.deleteMany.mock.calls[0]?.[0] as DeleteArgs;
    expect(removal.where.id.in).toHaveLength(TRANSCRIPTION_CACHE_PURGE_BATCH);
    await cron();
    expect(remaining()).toHaveLength(0);
  });

  it('se questa pulizia fallisce le altre continuano e il battito si salva', async () => {
    mocks.findMany.mockRejectedValue(new Error('db giù'));
    const response = await cron();
    expect(response.status).toBe(200);
    expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
      'cleanup',
      expect.stringContaining('0 trascrizioni cifrate non usate'),
    );
  });
});
