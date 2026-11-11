// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runChecks: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/monitoring/checks.server', () => ({ runChecks: mocks.runChecks }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));

import {
  type MonitorCheckResult,
  MonitorRunSchema,
  PublicMonitorStatusSchema,
} from '@/lib/contracts/monitoring';
import {
  latestRun,
  listHeartbeats,
  type MonitorDeps,
  parseStoredRun,
  publicStatus,
  recentRuns,
  recordHeartbeat,
  runMonitor,
  STATUS_RUN_CLAIM,
  toRunSummary,
} from '@/lib/monitoring/monitor.server';

const NOW = new Date('2026-11-11T10:00:00.000Z');
const MINUTE = 60 * 1000;

function result(
  id: MonitorCheckResult['id'],
  status: MonitorCheckResult['status'] = 'ok',
): MonitorCheckResult {
  return { id, status, detail: 'dettaglio', ms: 12 };
}

const healthy = [result('database'), result('email', 'warn'), result('jamendo', 'warn')];

function row(minutesAgo: number, results: unknown = healthy, extra: Record<string, unknown> = {}) {
  return {
    id: `run-${minutesAgo}`,
    startedAt: new Date(NOW.getTime() - minutesAgo * MINUTE),
    durationMs: 900,
    status: 'ok',
    trigger: 'status',
    results,
    ...extra,
  };
}

type ClaimCreate = { data: { at: Date }[] };
type ClaimUpdate = { where: { at: { lt: Date } }; data: { at: Date } };

/** In-memory store; the 'status-run' claim row behaves like the conditional UPDATE in Postgres. */
function makeStore(rows: unknown[] = [], claimAt: Date | null = null) {
  const claim = { at: claimAt };
  return {
    claim,
    monitorRun: {
      create: vi.fn(async () => ({ id: 'run-new' })),
      findMany: vi.fn(async () => rows),
    },
    monitorHeartbeat: {
      upsert: vi.fn(async (_args: unknown) => ({})),
      findMany: vi.fn(async (_args: unknown) => []),
      createMany: vi.fn(async ({ data }: ClaimCreate) => {
        if (claim.at) return { count: 0 };
        claim.at = data[0]?.at ?? null;
        return { count: 1 };
      }),
      updateMany: vi.fn(async ({ where, data }: ClaimUpdate) => {
        if (!claim.at || claim.at.getTime() >= where.at.lt.getTime()) return { count: 0 };
        claim.at = data.at;
        return { count: 1 };
      }),
    },
  };
}

function deps(store: ReturnType<typeof makeStore>, extra: Partial<MonitorDeps> = {}) {
  return {
    db: store as unknown as MonitorDeps['db'],
    now: () => NOW,
    clock: () => 0,
    runChecks: mocks.runChecks,
    consumeRateLimit: mocks.consumeRateLimit,
    ...extra,
  } satisfies Partial<MonitorDeps>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runChecks.mockResolvedValue([
    result('database'),
    result('youtube_quota', 'fail'),
    result('email', 'warn'),
  ]);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
});

describe('runMonitor', () => {
  it('stores the run with its overall status and returns the contract shape', async () => {
    const store = makeStore();
    const run = await runMonitor('admin', deps(store));
    expect(MonitorRunSchema.parse(run)).toEqual(run);
    expect(run).toMatchObject({
      id: 'run-new',
      startedAt: NOW.toISOString(),
      status: 'degraded',
      trigger: 'admin',
    });
    expect(store.monitorRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'degraded', trigger: 'admin', startedAt: NOW }),
      select: { id: true },
    });
  });

  it('computes the overall status: critical failure = down, warnings alone = ok', async () => {
    const store = makeStore();
    mocks.runChecks.mockResolvedValueOnce([
      result('signup_write', 'fail'),
      result('radio', 'fail'),
    ]);
    expect((await runMonitor('cron', deps(store))).status).toBe('down');
    mocks.runChecks.mockResolvedValueOnce([result('database'), result('stripe', 'warn')]);
    expect((await runMonitor('cron', deps(store))).status).toBe('ok');
  });

  it('still returns the results when the run cannot be saved', async () => {
    const store = makeStore();
    store.monitorRun.create.mockRejectedValue(new Error('db down'));
    const run = await runMonitor('cron', deps(store));
    expect(run.id).toMatch(/^unsaved-/);
    expect(run.results).toHaveLength(3);
  });
});

describe('stored runs', () => {
  it('drops invalid result entries and invalid runs instead of throwing', async () => {
    const store = makeStore([
      row(1, 'not-an-array', { status: 'exploded' }),
      row(2, [result('database'), { id: 'removed_check', status: 'ok', detail: '', ms: 1 }, null]),
    ]);
    const runs = await recentRuns(48, deps(store));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.results.map((entry) => entry.id)).toEqual(['database']);
    expect(await latestRun(deps(store))).toMatchObject({ id: 'run-2' });
    expect(store.monitorRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { startedAt: 'desc' } }),
    );
  });

  it('caps the history at 48 runs and summarises failing ids', async () => {
    const store = makeStore([row(1, [result('database', 'fail'), result('email', 'warn')])]);
    await recentRuns(500, deps(store));
    expect(store.monitorRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 48 }));
    const [run] = await recentRuns(48, deps(store));
    expect(run && toRunSummary(run)).toMatchObject({ failing: ['database'] });
  });

  it('parseStoredRun rejects an invalid date', () => {
    const stored = { ...row(1), startedAt: new Date('nope') } as Parameters<
      typeof parseStoredRun
    >[0];
    expect(parseStoredRun(stored)).toBeNull();
  });
});

describe('recordHeartbeat', () => {
  it('upserts the heartbeat and never throws', async () => {
    const store = makeStore();
    expect(await recordHeartbeat('cleanup', 'Rimossi: 3', deps(store))).toBe(true);
    expect(store.monitorHeartbeat.upsert).toHaveBeenCalledWith({
      where: { name: 'cleanup' },
      create: { name: 'cleanup', at: NOW, detail: 'Rimossi: 3' },
      update: { at: NOW, detail: 'Rimossi: 3' },
    });
    store.monitorHeartbeat.upsert.mockRejectedValue(new Error('db down'));
    expect(await recordHeartbeat('cleanup', undefined, deps(store))).toBe(false);
  });
});

describe('listHeartbeats', () => {
  it('lists scheduled-job heartbeats but not the public refresh lock', async () => {
    const store = makeStore();
    await listHeartbeats(deps(store));
    expect(store.monitorHeartbeat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: { not: STATUS_RUN_CLAIM } } }),
    );
  });
});

describe('publicStatus', () => {
  it('reuses a run younger than 50 minutes without spending the rate limit', async () => {
    const store = makeStore([
      row(10, [result('database'), result('radio', 'fail'), result('email', 'warn')], {
        status: 'degraded',
      }),
    ]);
    const status = await publicStatus(NOW, deps(store));
    expect(PublicMonitorStatusSchema.parse(status)).toEqual({
      status: 'degraded',
      checkedAt: new Date(NOW.getTime() - 10 * MINUTE).toISOString(),
      stale: false,
      failing: ['radio'],
      warnings: ['email'],
    });
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.runChecks).not.toHaveBeenCalled();
  });

  it('starts a new run when the latest is older than 50 minutes and the limit allows it', async () => {
    const store = makeStore([row(55)]);
    const status = await publicStatus(NOW, deps(store));
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('monitor.run', 'global');
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
    expect(store.monitorRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: 'status' }) }),
    );
    expect(status).toEqual({
      status: 'degraded',
      checkedAt: NOW.toISOString(),
      stale: false,
      failing: ['youtube_quota'],
      warnings: ['email'],
    });
  });

  it('claims the refresh atomically before spending the rate limit', async () => {
    const store = makeStore([row(55)]);
    await publicStatus(NOW, deps(store));
    expect(store.monitorHeartbeat.createMany).toHaveBeenCalledWith({
      data: [{ name: STATUS_RUN_CLAIM, at: new Date(0), detail: null }],
      skipDuplicates: true,
    });
    expect(store.monitorHeartbeat.updateMany).toHaveBeenCalledWith({
      where: { name: STATUS_RUN_CLAIM, at: { lt: new Date(NOW.getTime() - 50 * MINUTE) } },
      data: { at: NOW },
    });
    expect(store.claim.at).toEqual(NOW);
  });

  it('starts exactly one run when concurrent requests see the same stale run', async () => {
    const store = makeStore([row(55)]);
    const statuses = await Promise.all(
      Array.from({ length: 4 }, () => publicStatus(NOW, deps(store))),
    );
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
    expect(store.monitorRun.create).toHaveBeenCalledTimes(1);
    const checkedAt = statuses.map((status) => status.checkedAt);
    expect(checkedAt.filter((value) => value === NOW.toISOString())).toHaveLength(1);
    expect(
      checkedAt.filter((value) => value === new Date(NOW.getTime() - 55 * MINUTE).toISOString()),
    ).toHaveLength(3);
  });

  it('serves the old run without spending the limit when another request claimed the refresh', async () => {
    const store = makeStore([row(55)], new Date(NOW.getTime() - 10 * MINUTE));
    const status = await publicStatus(NOW, deps(store));
    expect(status).toMatchObject({ status: 'ok', stale: false });
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.runChecks).not.toHaveBeenCalled();
  });

  it('lets a claim error through so the route can answer 503', async () => {
    const store = makeStore([row(55)]);
    store.monitorHeartbeat.updateMany.mockRejectedValue(new Error('db read-only'));
    await expect(publicStatus(NOW, deps(store))).rejects.toThrow('db read-only');
    expect(mocks.runChecks).not.toHaveBeenCalled();
  });

  it('keeps the old run, flagged stale past two hours, when the limit refuses', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 600,
      error: 'rate_limited',
      message: 'x',
    });
    const stale = await publicStatus(NOW, deps(makeStore([row(180)])));
    expect(stale).toMatchObject({ status: 'ok', stale: true, warnings: ['email', 'jamendo'] });
    const notYetStale = await publicStatus(NOW, deps(makeStore([row(60)])));
    expect(notYetStale).toMatchObject({ status: 'ok', stale: false });
    expect(mocks.runChecks).not.toHaveBeenCalled();
  });

  it('reports unknown when no run exists and none may start', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 503,
      retryAfterSeconds: 30,
      error: 'rate_limit_unavailable',
      message: 'x',
    });
    expect(await publicStatus(NOW, deps(makeStore([])))).toEqual({
      status: 'unknown',
      checkedAt: null,
      stale: false,
      failing: [],
      warnings: [],
    });
  });

  it('runs the first check when no run exists and the limit allows it', async () => {
    const status = await publicStatus(NOW, deps(makeStore([])));
    expect(status.status).toBe('degraded');
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
  });

  it('lets a database read error through so the route can answer 503', async () => {
    const store = makeStore();
    store.monitorRun.findMany.mockRejectedValue(new Error('db down'));
    await expect(publicStatus(NOW, deps(store))).rejects.toThrow('db down');
  });

  it('uses the app-wide monitor.run limit by default', async () => {
    const store = makeStore([]);
    await publicStatus(NOW, { db: store as unknown as MonitorDeps['db'], now: () => NOW });
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('monitor.run', 'global');
    expect(mocks.runChecks).toHaveBeenCalledWith();
  });
});
