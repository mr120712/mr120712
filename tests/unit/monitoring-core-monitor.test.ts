// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runChecks: vi.fn(),
  consumeRateLimit: vi.fn(),
  after: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: mocks.after }));
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
  PUBLIC_READ_DEADLINE_MS,
  PublicStatusDeadlineError,
  type PublicStatusDeps,
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
type ClaimUpdate = { where: { at: { lt: Date } | Date }; data: { at: Date } };

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
        // `at: { lt }` takes the claim, `at: <date>` gives back a claim that is still ours.
        const matches =
          where.at instanceof Date
            ? claim.at?.getTime() === where.at.getTime()
            : claim.at !== null && claim.at.getTime() < where.at.lt.getTime();
        if (!matches) return { count: 0 };
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

type Task = () => Promise<void>;

/** Collects the tasks scheduled after the response: the test decides when (and if) they run. */
function statusDeps(
  store: ReturnType<typeof makeStore>,
  extra: Partial<PublicStatusDeps> = {},
): { tasks: Task[]; options: Partial<PublicStatusDeps> } {
  const tasks: Task[] = [];
  return {
    tasks,
    options: {
      ...deps(store),
      schedule: (task) => {
        tasks.push(task);
      },
      readDeadlineMs: 1_000,
      ...extra,
    },
  };
}

/** A promise that never settles: a query on a database that does not answer. */
function hanging<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const refused = {
  allowed: false,
  status: 429,
  retryAfterSeconds: 600,
  error: 'rate_limited',
  message: 'x',
};

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
  const oldRun = {
    status: 'ok',
    checkedAt: new Date(NOW.getTime() - 55 * MINUTE).toISOString(),
    stale: false,
    failing: [],
    warnings: ['email', 'jamendo'],
  };

  it('reuses a run younger than 50 minutes without claiming or scheduling a refresh', async () => {
    const store = makeStore([
      row(10, [result('database'), result('radio', 'fail'), result('email', 'warn')], {
        status: 'degraded',
      }),
    ]);
    const { tasks, options } = statusDeps(store);
    const status = await publicStatus(NOW, options);
    expect(PublicMonitorStatusSchema.parse(status)).toEqual({
      status: 'degraded',
      checkedAt: new Date(NOW.getTime() - 10 * MINUTE).toISOString(),
      stale: false,
      failing: ['radio'],
      warnings: ['email'],
    });
    expect(tasks).toHaveLength(0);
    expect(store.monitorHeartbeat.updateMany).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.runChecks).not.toHaveBeenCalled();
  });

  it('answers with the old run at once and schedules one refresh when it is older than 50 minutes', async () => {
    const store = makeStore([row(55)]);
    const { tasks, options } = statusDeps(store);
    expect(await publicStatus(NOW, options)).toEqual(oldRun);
    expect(tasks).toHaveLength(1);
    // Nothing of the refresh has run before the answer.
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.runChecks).not.toHaveBeenCalled();

    await tasks[0]?.();
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('monitor.run', 'global');
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
    expect(store.monitorRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: 'status' }) }),
    );
  });

  it('never waits for the refresh, even when the scheduler starts it at once', async () => {
    mocks.runChecks.mockReturnValue(hanging());
    const store = makeStore([row(55)]);
    const { options } = statusDeps(store, {
      schedule: (task) => {
        void task();
      },
    });
    expect(await publicStatus(NOW, options)).toEqual(oldRun);
    await flush();
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
    expect(store.monitorRun.create).not.toHaveBeenCalled();
  });

  it('claims the refresh atomically before scheduling it', async () => {
    const store = makeStore([row(55)]);
    const { tasks, options } = statusDeps(store);
    await publicStatus(NOW, options);
    expect(store.monitorHeartbeat.createMany).toHaveBeenCalledWith({
      data: [{ name: STATUS_RUN_CLAIM, at: new Date(0), detail: null }],
      skipDuplicates: true,
    });
    expect(store.monitorHeartbeat.updateMany).toHaveBeenCalledWith({
      where: { name: STATUS_RUN_CLAIM, at: { lt: new Date(NOW.getTime() - 50 * MINUTE) } },
      data: { at: NOW },
    });
    expect(store.claim.at).toEqual(NOW);
    expect(tasks).toHaveLength(1);
  });

  it('schedules exactly one refresh when concurrent requests see the same stale run', async () => {
    const store = makeStore([row(55)]);
    const { tasks, options } = statusDeps(store);
    const statuses = await Promise.all(Array.from({ length: 4 }, () => publicStatus(NOW, options)));
    expect(statuses).toEqual([oldRun, oldRun, oldRun, oldRun]);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks.map((task) => task()));
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
    expect(store.monitorRun.create).toHaveBeenCalledTimes(1);
  });

  it('schedules nothing when another request already claimed the refresh', async () => {
    const store = makeStore([row(55)], new Date(NOW.getTime() - 10 * MINUTE));
    const { tasks, options } = statusDeps(store);
    expect(await publicStatus(NOW, options)).toMatchObject({ status: 'ok', stale: false });
    expect(tasks).toHaveLength(0);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('claims again 50 minutes later when a refresh never finished', async () => {
    const store = makeStore([row(55)]);
    const { tasks, options } = statusDeps(store);
    await publicStatus(NOW, options);
    expect(tasks).toHaveLength(1);
    // The instance was stopped: the refresh never ran and no new run was stored.
    await publicStatus(new Date(NOW.getTime() + 10 * MINUTE), options);
    expect(tasks).toHaveLength(1);
    await publicStatus(new Date(NOW.getTime() + 51 * MINUTE), options);
    expect(tasks).toHaveLength(2);
  });

  it('lets a claim error through so the route can answer 503', async () => {
    const store = makeStore([row(55)]);
    store.monitorHeartbeat.updateMany.mockRejectedValue(new Error('db read-only'));
    const { tasks, options } = statusDeps(store);
    await expect(publicStatus(NOW, options)).rejects.toThrow('db read-only');
    expect(tasks).toHaveLength(0);
  });

  it('starts no run when the limit refuses, and keeps the old run (stale past two hours)', async () => {
    mocks.consumeRateLimit.mockResolvedValue(refused);
    const stale = statusDeps(makeStore([row(180)]));
    expect(await publicStatus(NOW, stale.options)).toMatchObject({
      status: 'ok',
      stale: true,
      warnings: ['email', 'jamendo'],
    });
    const notYetStale = statusDeps(makeStore([row(60)]));
    expect(await publicStatus(NOW, notYetStale.options)).toMatchObject({
      status: 'ok',
      stale: false,
    });
    await Promise.all([...stale.tasks, ...notYetStale.tasks].map((task) => task()));
    expect(mocks.consumeRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.runChecks).not.toHaveBeenCalled();
  });

  it('reports unknown when no run exists and schedules the first one', async () => {
    const { tasks, options } = statusDeps(makeStore([]));
    expect(await publicStatus(NOW, options)).toEqual({
      status: 'unknown',
      checkedAt: null,
      stale: false,
      failing: [],
      warnings: [],
    });
    expect(tasks).toHaveLength(1);
    await tasks[0]?.();
    expect(mocks.runChecks).toHaveBeenCalledTimes(1);
  });

  it('swallows every error of the background refresh', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const limitDown = statusDeps(makeStore([row(55)]));
      await publicStatus(NOW, limitDown.options);
      mocks.consumeRateLimit.mockRejectedValueOnce(new Error('db down'));
      await expect(limitDown.tasks[0]?.()).resolves.toBeUndefined();

      const checksDown = statusDeps(makeStore([row(55)]));
      await publicStatus(NOW, checksDown.options);
      mocks.runChecks.mockRejectedValueOnce(new Error('boom'));
      await expect(checksDown.tasks[0]?.()).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  it('still answers when the refresh cannot be scheduled', async () => {
    const store = makeStore([row(55)]);
    const { options } = statusDeps(store, {
      schedule: () => {
        throw new Error('`after` was called outside a request scope');
      },
    });
    expect(await publicStatus(NOW, options)).toEqual(oldRun);
  });

  it('gives up on a slow database read: deadline error, no claim, no refresh', async () => {
    const store = makeStore();
    store.monitorRun.findMany.mockReturnValue(hanging());
    const { tasks, options } = statusDeps(store, { readDeadlineMs: 20 });
    await expect(publicStatus(NOW, options)).rejects.toBeInstanceOf(PublicStatusDeadlineError);
    expect(store.monitorHeartbeat.createMany).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it('never takes the claim when a slow read finishes after the deadline', async () => {
    const store = makeStore();
    let finishRead: (rows: unknown[]) => void = () => {};
    store.monitorRun.findMany.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        finishRead = resolve;
      }),
    );
    const { tasks, options } = statusDeps(store, { readDeadlineMs: 20 });
    await expect(publicStatus(NOW, options)).rejects.toBeInstanceOf(PublicStatusDeadlineError);
    finishRead([row(55)]);
    await flush();
    expect(store.monitorHeartbeat.createMany).not.toHaveBeenCalled();
    expect(store.monitorHeartbeat.updateMany).not.toHaveBeenCalled();
    expect(store.claim.at).toBeNull();
    expect(tasks).toHaveLength(0);
  });

  it('counts the claim in the same deadline', async () => {
    const store = makeStore([row(55)]);
    store.monitorHeartbeat.updateMany.mockReturnValue(hanging());
    const { tasks, options } = statusDeps(store, { readDeadlineMs: 20 });
    await expect(publicStatus(NOW, options)).rejects.toBeInstanceOf(PublicStatusDeadlineError);
    expect(tasks).toHaveLength(0);
  });

  it('never takes the claim when creating the claim row finishes after the deadline', async () => {
    const store = makeStore([row(55)]);
    let finishCreate: (value: { count: number }) => void = () => {};
    store.monitorHeartbeat.createMany.mockReturnValue(
      new Promise<{ count: number }>((resolve) => {
        finishCreate = resolve;
      }),
    );
    const { tasks, options } = statusDeps(store, { readDeadlineMs: 20 });
    await expect(publicStatus(NOW, options)).rejects.toBeInstanceOf(PublicStatusDeadlineError);
    finishCreate({ count: 1 });
    await flush();
    expect(store.monitorHeartbeat.updateMany).not.toHaveBeenCalled();
    expect(store.claim.at).toBeNull();
    expect(tasks).toHaveLength(0);
  });

  it('gives back a claim taken after the deadline, so the next request can refresh', async () => {
    const store = makeStore([row(55)], new Date(0));
    const takeClaim = store.monitorHeartbeat.updateMany.getMockImplementation();
    let finishClaim: () => void = () => {};
    store.monitorHeartbeat.updateMany.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          finishClaim = () => resolve(takeClaim?.(args) ?? { count: 0 });
        }),
    );
    const { tasks, options } = statusDeps(store, { readDeadlineMs: 20 });
    await expect(publicStatus(NOW, options)).rejects.toBeInstanceOf(PublicStatusDeadlineError);
    finishClaim();
    await flush();
    expect(store.monitorHeartbeat.updateMany).toHaveBeenLastCalledWith({
      where: { name: STATUS_RUN_CLAIM, at: NOW },
      data: { at: new Date(0) },
    });
    expect(store.claim.at).toEqual(new Date(0));
    expect(tasks).toHaveLength(0);

    await publicStatus(new Date(NOW.getTime() + MINUTE), options);
    expect(tasks).toHaveLength(1);
  });

  it('clears the deadline timer once the database work is done', async () => {
    vi.useFakeTimers();
    try {
      const { tasks, options } = statusDeps(makeStore([row(55)]), { readDeadlineMs: 20_000 });
      expect(await publicStatus(NOW, options)).toEqual(oldRun);
      expect(tasks).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a database read error through so the route can answer 503', async () => {
    const store = makeStore();
    store.monitorRun.findMany.mockRejectedValue(new Error('db down'));
    const { tasks, options } = statusDeps(store);
    await expect(publicStatus(NOW, options)).rejects.toThrow('db down');
    expect(tasks).toHaveLength(0);
  });

  it('uses after(), a 20 s deadline, the monitor.run limit and every check by default', async () => {
    // Two tries of the GitHub monitor (5 s apart) cover a 30 s database wake-up.
    expect(PUBLIC_READ_DEADLINE_MS).toBe(20_000);
    const store = makeStore([]);
    await publicStatus(NOW, { db: store as unknown as MonitorDeps['db'], now: () => NOW });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    await (mocks.after.mock.calls[0] as [Task])[0]();
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('monitor.run', 'global');
    expect(mocks.runChecks).toHaveBeenCalledWith();
  });
});
