// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  publicStatus: vi.fn(),
  runMonitor: vi.fn(),
  recentRuns: vi.fn(),
  listHeartbeats: vi.fn(),
  recordHeartbeat: vi.fn(),
  expireYouTubeCollectionMetadata: vi.fn(),
  songResolutionDelete: vi.fn(),
  searchCacheDelete: vi.fn(),
  aiCacheDelete: vi.fn(),
  monitorRunDelete: vi.fn(),
  historyDelete: vi.fn(),
  historyFetchDelete: vi.fn(),
  quotaUsageDelete: vi.fn(),
  rateLimitDelete: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/db', () => ({
  prisma: {
    songResolution: { deleteMany: mocks.songResolutionDelete },
    youTubeSearchCache: { deleteMany: mocks.searchCacheDelete },
    // Expired YouTube history entries are removed with one plain SQL statement.
    $executeRaw: mocks.historyDelete,
    youTubeHistoryFetch: { deleteMany: mocks.historyFetchDelete },
    youTubeQuotaUsage: { deleteMany: mocks.quotaUsageDelete },
    actionRateLimit: { deleteMany: mocks.rateLimitDelete },
    aiMusicSearchCache: { deleteMany: mocks.aiCacheDelete },
    monitorRun: { deleteMany: mocks.monitorRunDelete },
  },
}));
vi.mock('@/lib/music/collections.server', () => ({
  expireYouTubeCollectionMetadata: mocks.expireYouTubeCollectionMetadata,
}));
vi.mock('@/lib/monitoring/checks.server', () => ({
  CLEANUP_HEARTBEAT: 'cleanup',
  runChecks: vi.fn(),
}));
vi.mock('@/lib/monitoring/monitor.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/monitoring/monitor.server')>()),
  publicStatus: mocks.publicStatus,
  runMonitor: mocks.runMonitor,
  recentRuns: mocks.recentRuns,
  listHeartbeats: mocks.listHeartbeats,
  recordHeartbeat: mocks.recordHeartbeat,
}));

import * as adminRoute from '@/app/api/admin/monitoring/route';
import * as cleanupRoute from '@/app/api/cron/cleanup/route';
import * as healthRoute from '@/app/api/cron/health/route';
import * as statusRoute from '@/app/api/status/route';
import { cronAuthorized } from '@/lib/business/cron-auth.server';
import {
  AdminMonitoringSchema,
  AdminMonitorRunResponseSchema,
  type MonitorRun,
  PublicMonitorStatusSchema,
} from '@/lib/contracts/monitoring';
import { PublicStatusDeadlineError } from '@/lib/monitoring/monitor.server';

const CRON_SECRET = 'fake-cron-secret-0123456789abcdef';
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

const run: MonitorRun = {
  id: 'run-1',
  startedAt: '2026-11-11T09:00:00.000Z',
  durationMs: 1800,
  status: 'down',
  trigger: 'admin',
  results: [
    { id: 'database', status: 'ok', detail: 'Lettura e scrittura riuscite in 40 ms', ms: 40 },
    { id: 'google_signin', status: 'fail', detail: 'Google rifiuta la richiesta', ms: 300 },
    { id: 'email', status: 'warn', detail: 'Email non configurate', ms: 0 },
  ],
};

function cronRequest(path: string, authorization?: string) {
  return new Request(`https://solco.test${path}`, {
    headers: authorization ? { authorization } : {},
  });
}

function adminRequest(method: 'GET' | 'POST', body?: string) {
  return new Request('https://solco.test/api/admin/monitoring', {
    method,
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.runMonitor.mockResolvedValue(run);
  mocks.recentRuns.mockResolvedValue([run]);
  mocks.listHeartbeats.mockResolvedValue([
    { name: 'cleanup', at: '2026-11-11T03:17:00.000Z', detail: 'Rimossi: 0' },
  ]);
  mocks.recordHeartbeat.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/status', () => {
  let warned: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warned.mockRestore();
  });

  it('returns the public status with a short shared cache', async () => {
    const status = {
      status: 'down',
      checkedAt: run.startedAt,
      stale: false,
      failing: ['google_signin'],
      warnings: ['email'],
      ok: ['database'],
    };
    mocks.publicStatus.mockResolvedValue(status);
    const response = await statusRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=60',
    );
    expect(PublicMonitorStatusSchema.parse(await response.json())).toEqual(status);
    expect(mocks.publicStatus).toHaveBeenCalledTimes(1);
    // The refresh runs after the response (after()) within the same function limit.
    expect(statusRoute.maxDuration).toBe(60);
    expect(statusRoute.dynamic).toBe('force-dynamic');
    expect(warned).not.toHaveBeenCalled();
  });

  it('keeps the shared cache for an old run that is being refreshed in the background', async () => {
    mocks.publicStatus.mockResolvedValue({
      status: 'ok',
      checkedAt: run.startedAt,
      stale: true,
      failing: [],
      warnings: [],
      ok: ['database', 'signup_write', 'auth_config', 'google_signin'],
    });
    const response = await statusRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=60',
    );
    expect(await response.json()).toMatchObject({ stale: true });
  });

  it('does not cache "unknown" (no run yet): the first run is starting in the background', async () => {
    const unknown = {
      status: 'unknown',
      checkedAt: null,
      stale: false,
      failing: [],
      warnings: [],
      ok: [],
    };
    mocks.publicStatus.mockResolvedValue(unknown);
    const response = await statusRoute.GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(unknown);
  });

  it('answers 503 unknown (not cached) when the database read passes its deadline', async () => {
    mocks.publicStatus.mockRejectedValue(new PublicStatusDeadlineError(20_000));
    const response = await statusRoute.GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'unknown', checkedAt: null });
    // Only the error name in the log: a deadline is told apart from a database error.
    expect(warned).toHaveBeenCalledWith(
      '[monitor] status unavailable',
      'PublicStatusDeadlineError',
    );
  });

  it('answers 503 unknown (not cached) when the status cannot be read', async () => {
    mocks.publicStatus.mockRejectedValue(new Error('db down'));
    const response = await statusRoute.GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'unknown',
      checkedAt: null,
      stale: true,
      failing: [],
      warnings: [],
      ok: [],
    });
    expect(warned).toHaveBeenCalledWith('[monitor] status unavailable', 'Error');
    expect(JSON.stringify(warned.mock.calls)).not.toContain('db down');
  });

  it('answers 503 when the result does not match the contract', async () => {
    mocks.publicStatus.mockResolvedValue({ status: 'fine' });
    expect((await statusRoute.GET()).status).toBe(503);
  });
});

describe('cron authorization', () => {
  it('accepts only the exact bearer secret of at least 24 characters', () => {
    const env = { CRON_SECRET };
    expect(cronAuthorized(cronRequest('/x', `Bearer ${CRON_SECRET}`), env)).toBe(true);
    expect(cronAuthorized(cronRequest('/x'), env)).toBe(false);
    expect(cronAuthorized(cronRequest('/x', `Bearer ${CRON_SECRET}x`), env)).toBe(false);
    expect(cronAuthorized(cronRequest('/x', CRON_SECRET), env)).toBe(false);
    expect(cronAuthorized(cronRequest('/x', 'Bearer short'), { CRON_SECRET: 'short' })).toBe(false);
    expect(cronAuthorized(cronRequest('/x', 'Bearer '), {})).toBe(false);
  });
});

describe('GET /api/cron/health', () => {
  it('refuses requests without the cron secret', async () => {
    for (const authorization of [undefined, 'Bearer wrong-secret-0123456789abcdef']) {
      const response = await healthRoute.GET(cronRequest('/api/cron/health', authorization));
      expect(response.status).toBe(401);
    }
    vi.stubEnv('CRON_SECRET', '');
    expect((await healthRoute.GET(cronRequest('/api/cron/health', 'Bearer '))).status).toBe(401);
    expect(mocks.runMonitor).not.toHaveBeenCalled();
  });

  it('runs every check as the cron trigger and returns status and failing ids', async () => {
    const response = await healthRoute.GET(
      cronRequest('/api/cron/health', `Bearer ${CRON_SECRET}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'down', failing: ['google_signin'] });
    expect(mocks.runMonitor).toHaveBeenCalledWith('cron');
    expect(healthRoute.maxDuration).toBe(60);
  });
});

describe('GET /api/cron/cleanup', () => {
  beforeEach(() => {
    mocks.expireYouTubeCollectionMetadata.mockResolvedValue({ count: 1 });
    mocks.songResolutionDelete.mockResolvedValue({ count: 2 });
    mocks.searchCacheDelete.mockResolvedValue({ count: 3 });
    mocks.aiCacheDelete.mockResolvedValue({ count: 4 });
    mocks.monitorRunDelete.mockResolvedValue({ count: 5 });
    mocks.historyDelete.mockResolvedValue(6);
    mocks.historyFetchDelete.mockResolvedValue({ count: 8 });
    mocks.quotaUsageDelete.mockResolvedValue({ count: 7 });
    mocks.rateLimitDelete.mockResolvedValue({ count: 9 });
  });

  it('refuses requests without the cron secret', async () => {
    const response = await cleanupRoute.GET(cronRequest('/api/cron/cleanup', 'Bearer nope'));
    expect(response.status).toBe(401);
    expect(mocks.monitorRunDelete).not.toHaveBeenCalled();
    expect(mocks.recordHeartbeat).not.toHaveBeenCalled();
  });

  it('also removes runs older than 30 days and records the cleanup heartbeat', async () => {
    const before = Date.now();
    const response = await cleanupRoute.GET(
      cronRequest('/api/cron/cleanup', `Bearer ${CRON_SECRET}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      youtubeCollectionItems: 1,
      songResolutions: 2,
      youtubeSearches: 3,
      youtubeHistory: 6,
      youtubeQuotaDays: 7,
      rateLimitRows: 9,
      aiPlans: 4,
      monitorRuns: 5,
    });
    const cutoff = (
      mocks.monitorRunDelete.mock.calls[0] as [{ where: { startedAt: { lt: Date } } }]
    )[0].where.startedAt.lt.getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - thirtyDays - 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - thirtyDays);
    expect(mocks.recordHeartbeat).toHaveBeenCalledWith(
      'cleanup',
      expect.stringContaining('5 controlli'),
    );
    expect((mocks.recordHeartbeat.mock.calls[0] as [string, string])[1].length).toBeLessThanOrEqual(
      300,
    );
  });

  it('deletes YouTube API data well before 30 days from when YouTube sent it', async () => {
    const before = Date.now();
    await cleanupRoute.GET(cronRequest('/api/cron/cleanup', `Bearer ${CRON_SECRET}`));
    const day = 24 * 60 * 60 * 1000;
    const [searches, charts] = (
      mocks.searchCacheDelete.mock.calls[0] as [
        {
          where: {
            OR: [
              { createdAt: { lt: Date } },
              { key: { startsWith: string }; createdAt: { lt: Date } },
            ];
          };
        },
      ]
    )[0].where.OR;
    const searchCutoff = searches.createdAt.lt.getTime();
    expect(before - searchCutoff).toBeGreaterThanOrEqual(28 * day - 1000);
    expect(Date.now() - searchCutoff).toBeLessThanOrEqual(28 * day + 1000);
    // Country charts are never shown after 24 h: deleted at the next run.
    expect(charts.key.startsWith).toBe('chart:');
    expect(before - charts.createdAt.lt.getTime()).toBeGreaterThanOrEqual(day - 1000);
    expect(Date.now() - charts.createdAt.lt.getTime()).toBeLessThanOrEqual(day + 1000);

    // Per-account and per-IP rate-limit counters (hashed) are kept 2 days at most.
    const rateLimitCutoff = (
      mocks.rateLimitDelete.mock.calls[0] as [{ where: { updatedAt: { lt: Date } } }]
    )[0].where.updatedAt.lt.getTime();
    expect(before - rateLimitCutoff).toBeGreaterThanOrEqual(2 * day - 1000);
    expect(Date.now() - rateLimitCutoff).toBeLessThanOrEqual(2 * day + 1000);

    // Matched songs: by expiry, and in any case 28 days after YouTube sent the data.
    const songs = (
      mocks.songResolutionDelete.mock.calls[0] as [
        { where: { OR: [{ expiresAt: { lte: Date } }, { createdAt: { lt: Date } }] } },
      ]
    )[0].where.OR;
    expect(songs[0].expiresAt.lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(before - songs[1].createdAt.lt.getTime()).toBeGreaterThanOrEqual(28 * day - 1000);
    expect(Date.now() - songs[1].createdAt.lt.getTime()).toBeLessThanOrEqual(28 * day + 1000);

    // History: aged by the date YouTube sent the data, never by the last play; then every
    // YouTube entry left without a date is removed.
    const dates = (
      mocks.historyFetchDelete.mock.calls[0] as [{ where: { fetchedAt: { lte: Date } } }]
    )[0].where.fetchedAt.lte.getTime();
    expect(before - dates).toBeGreaterThanOrEqual(28 * day - 1000);
    expect(Date.now() - dates).toBeLessThanOrEqual(28 * day + 1000);
    const sql = (mocks.historyDelete.mock.calls[0] as [TemplateStringsArray])[0].join('?');
    expect(sql).toContain('DELETE FROM "UserPlaybackHistory"');
    expect(sql).toContain(`LIKE 'youtube:%'`);
    expect(sql).toContain('NOT EXISTS');
    expect(sql).not.toContain('lastPlayedAt');

    // Collection metadata expiring before the next daily run is removed now.
    const collectionsUntil = (
      mocks.expireYouTubeCollectionMetadata.mock.calls[0] as [Date]
    )[0].getTime();
    expect(collectionsUntil - before).toBeGreaterThanOrEqual(day - 1000);
    expect(collectionsUntil - Date.now()).toBeLessThanOrEqual(day + 1000);
    expect(mocks.quotaUsageDelete).toHaveBeenCalledOnce();
  });

  it('does not record the heartbeat when a cleanup step fails', async () => {
    mocks.monitorRunDelete.mockRejectedValue(new Error('db down'));
    await expect(
      cleanupRoute.GET(cronRequest('/api/cron/cleanup', `Bearer ${CRON_SECRET}`)),
    ).rejects.toThrow();
    expect(mocks.recordHeartbeat).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/monitoring', () => {
  it('answers 401 without a session and 403 for non-admins or unverified admins', async () => {
    mocks.getSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: { ...admin, role: 'user' } })
      .mockResolvedValueOnce({ user: { ...admin, emailVerified: false } });
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await adminRoute.GET(adminRequest('GET'));
      statuses.push(response.status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toBe('Cookie');
    }
    expect(statuses).toEqual([401, 403, 403]);
    expect(mocks.recentRuns).not.toHaveBeenCalled();
  });

  it('answers 503 when the session cannot be read', async () => {
    mocks.getSession.mockRejectedValue(new Error('auth down'));
    expect((await adminRoute.GET(adminRequest('GET'))).status).toBe(503);
  });

  it('returns the latest run, the 48-run history and the heartbeats', async () => {
    const response = await adminRoute.GET(adminRequest('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    const body = AdminMonitoringSchema.parse(await response.json());
    expect(body.latest).toEqual(run);
    expect(body.history).toEqual([
      {
        id: 'run-1',
        startedAt: run.startedAt,
        durationMs: 1800,
        status: 'down',
        trigger: 'admin',
        failing: ['google_signin'],
      },
    ]);
    expect(body.heartbeats).toHaveLength(1);
    expect(mocks.recentRuns).toHaveBeenCalledWith(48);
  });

  it('returns latest null and empty lists before the first run', async () => {
    mocks.recentRuns.mockResolvedValue([]);
    mocks.listHeartbeats.mockResolvedValue([]);
    const body = AdminMonitoringSchema.parse(
      await (await adminRoute.GET(adminRequest('GET'))).json(),
    );
    expect(body).toEqual({ latest: null, history: [], heartbeats: [] });
  });

  it('answers 503 when the history cannot be read', async () => {
    mocks.recentRuns.mockRejectedValue(new Error('db down'));
    const response = await adminRoute.GET(adminRequest('GET'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('POST /api/admin/monitoring', () => {
  it('refuses a cross-site request before reading the session', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await adminRoute.POST(adminRequest('POST'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runMonitor).not.toHaveBeenCalled();
  });

  it('requires an admin session before spending the rate limit', async () => {
    mocks.getSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await adminRoute.POST(adminRequest('POST'))).status).toBe(401);
    expect((await adminRoute.POST(adminRequest('POST'))).status).toBe(403);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.runMonitor).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After and an Italian message when the admin limit refuses', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 240,
      error: 'rate_limited',
      message: 'generic',
    });
    const response = await adminRoute.POST(adminRequest('POST'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('240');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 240 });
    expect(body.message).toContain('4 minuti');
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('monitor.run.admin', 'user:admin-1');
    expect(mocks.runMonitor).not.toHaveBeenCalled();
  });

  it('runs every check as the admin trigger, ignoring any request body', async () => {
    const response = await adminRoute.POST(
      adminRequest('POST', JSON.stringify({ checks: ['email'], trigger: 'cron' })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(AdminMonitorRunResponseSchema.parse(await response.json())).toEqual({ run });
    expect(mocks.runMonitor).toHaveBeenCalledWith('admin');
    // Synchronous run: the admin needs the fresh result.
    expect(adminRoute.maxDuration).toBe(60);
  });
});
