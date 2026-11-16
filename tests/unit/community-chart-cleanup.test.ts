// @polsia:user-owned — pulizia giornaliera: cancella gli ascolti contati della classifica della
// community (chiavi HMAC) più vecchi di circa 35 giorni, e SOLO quelli; resta idempotente.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  playDelete: vi.fn(),
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
    publicUploadPlay: { deleteMany: mocks.playDelete },
    siteVisit: { deleteMany: zero },
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

const CRON_SECRET = 'fake-cron-secret-0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;

type Where = { createdAt: { lt: Date } };

function cron(authorization = `Bearer ${CRON_SECRET}`) {
  return GET(new Request('https://solco.test/api/cron/cleanup', { headers: { authorization } }));
}

/** Applica il filtro della pulizia a righe finte, come farebbe Postgres. */
function fakePlays(now: number, ages: number[]) {
  let rows = ages.map((days, index) => ({
    id: `play-${index}`,
    createdAt: new Date(now - days * DAY),
  }));
  mocks.playDelete.mockImplementation(async ({ where }: { where: Where }) => {
    const before = rows.length;
    rows = rows.filter((row) => !(row.createdAt < where.createdAt.lt));
    return { count: before - rows.length };
  });
  return () => rows.map((row) => row.id);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  mocks.recordHeartbeat.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/cron/cleanup: ascolti della classifica della community', () => {
  it('senza il segreto del cron non cancella nulla', async () => {
    expect((await cron('Bearer nope')).status).toBe(401);
    expect(mocks.playDelete).not.toHaveBeenCalled();
  });

  it('cancella solo le righe più vecchie di 35 giorni (filtro solo su createdAt)', async () => {
    const before = Date.now();
    mocks.playDelete.mockResolvedValue({ count: 4 });
    const response = await cron();
    expect(response.status).toBe(200);
    expect(mocks.playDelete).toHaveBeenCalledOnce();
    const { where } = (mocks.playDelete.mock.calls[0] as [{ where: Where }])[0];
    // Nessun altro criterio: niente cancellazioni per brano, ascoltatore o giorno.
    expect(Object.keys(where)).toEqual(['createdAt']);
    expect(Object.keys(where.createdAt)).toEqual(['lt']);
    const cutoff = where.createdAt.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(35 * DAY - 1000);
    expect(Date.now() - cutoff).toBeLessThanOrEqual(35 * DAY + 1000);

    expect((await response.json()).communityPlays).toBe(4);
    expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
      'cleanup',
      expect.stringContaining('4 ascolti della community vecchi'),
    );
  });

  it('tiene le righe recenti (anche di 34 giorni) e resta idempotente', async () => {
    const remaining = fakePlays(Date.now(), [0, 1, 34, 36, 90]);
    const first = await cron();
    expect((await first.json()).communityPlays).toBe(2);
    expect(remaining()).toEqual(['play-0', 'play-1', 'play-2']);

    const second = await cron();
    expect((await second.json()).communityPlays).toBe(0);
    expect(remaining()).toEqual(['play-0', 'play-1', 'play-2']);
  });
});
