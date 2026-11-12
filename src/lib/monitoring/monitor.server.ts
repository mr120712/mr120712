// @polsia:user-owned — servizio del monitoraggio automatico: esegue i controlli interni, salva
// l'esito (MonitorRun), legge lo storico e i battiti dei lavori pianificati. Usato da
// /api/status (pubblico), /api/cron/health (Vercel Cron) e /api/admin/monitoring.
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { after } from 'next/server';
import { consumeRateLimit, type RateLimitDecision } from '@/lib/business/rate-limit.server';
import {
  type MonitorCheckId,
  type MonitorCheckResult,
  MonitorCheckResultSchema,
  type MonitorHeartbeat,
  type MonitorRun,
  MonitorRunSchema,
  type MonitorRunSummary,
  type MonitorTrigger,
  type PublicMonitorStatus,
} from '@/lib/contracts/monitoring';
import { prisma } from '@/lib/db';
import { overallStatus } from '@/lib/monitoring/catalog';
import { runChecks } from '@/lib/monitoring/checks.server';

/** The public endpoint starts a new run when the latest one is older than this. */
export const PUBLIC_REFRESH_AFTER_MS = 50 * 60 * 1000;
/**
 * Budget of the public status for its own database work (latest run + refresh claim): a database
 * waking up must not hold /api/status until the function times out. Sized on the morning wake-up
 * seen live (about 30 s before the first query answered): the monitor's first try ends at 20 s,
 * its retry (5 s later) finds the database awake. Rule: 2 × deadline + 5 s ≥ the wake-up, and
 * deadline + cold start well below STATUS_TIMEOUT_MS (35 s) in scripts/monitor/check-site.ts.
 */
export const PUBLIC_READ_DEADLINE_MS = 20_000;
/** The latest run is reported as stale past this age. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const HISTORY_LIMIT = 48;
/**
 * MonitorHeartbeat row used as a lock: only the request that moves its time forward may start a
 * public run, so a burst of requests on a stale run starts one run, not one per request.
 */
export const STATUS_RUN_CLAIM = 'status-run';
const HEARTBEAT_DETAIL_MAX = 300;

type MonitorStore = Pick<PrismaClient, 'monitorRun' | 'monitorHeartbeat'>;

export type MonitorDeps = {
  db: MonitorStore;
  now: () => Date;
  clock: () => number;
  runChecks: () => Promise<MonitorCheckResult[]>;
  consumeRateLimit: (action: 'monitor.run', identity: string) => Promise<RateLimitDecision>;
};

function monitorDeps(overrides: Partial<MonitorDeps>): MonitorDeps {
  return {
    db: prisma,
    now: () => new Date(),
    clock: () => performance.now(),
    runChecks: () => runChecks(),
    consumeRateLimit: (action, identity) => consumeRateLimit(action, identity),
    ...overrides,
  };
}

type StoredRun = {
  id: string;
  startedAt: Date;
  durationMs: number;
  status: string;
  trigger: string;
  results: Prisma.JsonValue;
};

/** Stored JSON back into the contract: invalid results are dropped, an invalid run is null. */
export function parseStoredRun(row: StoredRun): MonitorRun | null {
  if (!(row.startedAt instanceof Date) || Number.isNaN(row.startedAt.getTime())) return null;
  const results = Array.isArray(row.results)
    ? row.results.flatMap((entry) => {
        const parsed = MonitorCheckResultSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const parsed = MonitorRunSchema.safeParse({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    durationMs: row.durationMs,
    status: row.status,
    trigger: row.trigger,
    results,
  });
  return parsed.success ? parsed.data : null;
}

function idsWithStatus(run: MonitorRun, status: MonitorCheckResult['status']): MonitorCheckId[] {
  return run.results.filter((result) => result.status === status).map((result) => result.id);
}

export function toRunSummary(run: MonitorRun): MonitorRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    status: run.status,
    trigger: run.trigger,
    failing: idsWithStatus(run, 'fail'),
  };
}

/** Runs every check, stores the run and returns it. Never throws on a storage failure. */
export async function runMonitor(
  trigger: MonitorTrigger,
  options: Partial<MonitorDeps> = {},
): Promise<MonitorRun> {
  const deps = monitorDeps(options);
  const startedAt = deps.now();
  const started = deps.clock();
  const results = await deps.runChecks();
  const durationMs = Math.max(0, Math.round(deps.clock() - started));
  const status = overallStatus(results);
  let id: string;
  try {
    const row = await deps.db.monitorRun.create({
      data: {
        startedAt,
        durationMs,
        status,
        trigger,
        results: results as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    id = row.id;
  } catch {
    // The database check already reports the outage: the results are still returned.
    id = `unsaved-${randomUUID()}`;
  }
  return { id, startedAt: startedAt.toISOString(), durationMs, status, trigger, results };
}

/**
 * Newest valid stored runs, newest first. Invalid stored data is skipped, never thrown; a
 * database error propagates so that callers can answer 503.
 */
export async function recentRuns(
  limit = HISTORY_LIMIT,
  options: Partial<MonitorDeps> = {},
): Promise<MonitorRun[]> {
  const deps = monitorDeps(options);
  const rows = await deps.db.monitorRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(limit))),
  });
  return rows.map(parseStoredRun).filter((run): run is MonitorRun => run !== null);
}

/** The newest valid stored run, or null. A database error propagates (callers answer 503). */
export async function latestRun(options: Partial<MonitorDeps> = {}): Promise<MonitorRun | null> {
  const deps = monitorDeps(options);
  const rows = await deps.db.monitorRun.findMany({ orderBy: { startedAt: 'desc' }, take: 3 });
  for (const row of rows) {
    const run = parseStoredRun(row);
    if (run) return run;
  }
  return null;
}

/** Records that a scheduled job ran. Never throws: false when it could not be saved. */
export async function recordHeartbeat(
  name: string,
  detail?: string | null,
  options: Partial<MonitorDeps> = {},
): Promise<boolean> {
  const deps = monitorDeps(options);
  const at = deps.now();
  const text = detail?.trim().slice(0, HEARTBEAT_DETAIL_MAX) || null;
  try {
    await deps.db.monitorHeartbeat.upsert({
      where: { name },
      create: { name, at, detail: text },
      update: { at, detail: text },
    });
    return true;
  } catch {
    return false;
  }
}

/** Every heartbeat, by name. A database error propagates (callers answer 503). */
export async function listHeartbeats(
  options: Partial<MonitorDeps> = {},
): Promise<MonitorHeartbeat[]> {
  const deps = monitorDeps(options);
  const rows = await deps.db.monitorHeartbeat.findMany({
    // The public refresh lock is not a scheduled job.
    where: { name: { not: STATUS_RUN_CLAIM } },
    orderBy: { name: 'asc' },
    take: 20,
  });
  return rows.map((row) => ({ name: row.name, at: row.at.toISOString(), detail: row.detail }));
}

function ageMs(run: MonitorRun, now: Date) {
  return now.getTime() - Date.parse(run.startedAt);
}

/**
 * Atomically claims the next public refresh: true for exactly one caller per 50-minute window,
 * across concurrent requests and instances (the conditional UPDATE re-checks the time under the
 * row lock). A database error propagates. Once `signal` is aborted (the request has already
 * answered 503) it never takes the claim, and gives back a claim taken too late, so that the next
 * request can refresh instead of waiting 50 minutes.
 */
async function claimPublicRefresh(
  deps: MonitorDeps,
  now: Date,
  signal?: AbortSignal,
): Promise<boolean> {
  await deps.db.monitorHeartbeat.createMany({
    data: [{ name: STATUS_RUN_CLAIM, at: new Date(0), detail: null }],
    skipDuplicates: true,
  });
  if (signal?.aborted) return false;
  const { count } = await deps.db.monitorHeartbeat.updateMany({
    where: {
      name: STATUS_RUN_CLAIM,
      at: { lt: new Date(now.getTime() - PUBLIC_REFRESH_AFTER_MS) },
    },
    data: { at: now },
  });
  if (count !== 1) return false;
  if (signal?.aborted) {
    // Only if the claim is still ours; nobody waits for it (best effort).
    deps.db.monitorHeartbeat
      .updateMany({ where: { name: STATUS_RUN_CLAIM, at: now }, data: { at: new Date(0) } })
      .catch(() => {});
    return false;
  }
  return true;
}

/** Runs a task after the response has been sent (default: next/server after(), waitUntil on Vercel). */
export type BackgroundScheduler = (task: () => Promise<void>) => void;

export type PublicStatusDeps = MonitorDeps & {
  schedule: BackgroundScheduler;
  /** Deadline of the foreground database work, in milliseconds. */
  readDeadlineMs: number;
};

/** The public status could not finish its database work within its deadline. */
export class PublicStatusDeadlineError extends Error {
  constructor(ms: number) {
    super(`Public status database work took longer than ${ms} ms`);
    this.name = 'PublicStatusDeadlineError';
  }
}

/**
 * Runs `work` with a hard deadline: past it the promise rejects with PublicStatusDeadlineError and
 * `signal` is aborted, so that the work skips the steps it has not started yet (a query already
 * sent cannot be cancelled: it finishes unobserved).
 */
async function withinDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PublicStatusDeadlineError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function needsRefresh(run: MonitorRun | null, now: Date) {
  return !run || ageMs(run, now) > PUBLIC_REFRESH_AFTER_MS;
}

/**
 * Background part of the public status, after the response: a new run if the app-wide
 * 'monitor.run' limit allows it. Never throws (runMonitor already survives a storage failure); if
 * it never finishes (instance stopped), the next claim after 50 minutes retries.
 */
async function refreshPublicRun(deps: MonitorDeps): Promise<void> {
  try {
    const decision = await deps.consumeRateLimit('monitor.run', 'global');
    if (decision.allowed) await runMonitor('status', deps);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: server log of the error name only (no details).
    console.error('[monitor] background refresh failed', error instanceof Error ? error.name : '?');
  }
}

/**
 * Public status: always answers from the latest stored run, never waiting for a new one. When
 * that run is older than 50 minutes (or missing), the one request that claims the refresh
 * schedules a new run after the response (see refreshPublicRun); every other request just reports
 * the stored run (stale past two hours). The database work (read + claim) has a deadline of
 * PUBLIC_READ_DEADLINE_MS: a database error or the deadline propagates so that /api/status answers
 * 503, and a request past its deadline never keeps the claim nor schedules a refresh.
 */
export async function publicStatus(
  now: Date = new Date(),
  options: Partial<PublicStatusDeps> = {},
): Promise<PublicMonitorStatus> {
  const {
    schedule = (task) => after(task),
    readDeadlineMs = PUBLIC_READ_DEADLINE_MS,
    ...overrides
  } = options;
  const deps = monitorDeps(overrides);
  const { run, claimed } = await withinDeadline(readDeadlineMs, async (signal) => {
    const latest = await latestRun(deps);
    // Past the deadline the request has already answered 503: it must not take the claim.
    if (signal.aborted || !needsRefresh(latest, now)) return { run: latest, claimed: false };
    return { run: latest, claimed: await claimPublicRefresh(deps, now, signal) };
  });
  if (claimed) {
    try {
      schedule(() => refreshPublicRun(deps));
    } catch {
      // No request scope to run it in: the next claim after 50 minutes retries.
    }
  }
  if (!run) {
    return { status: 'unknown', checkedAt: null, stale: false, failing: [], warnings: [] };
  }
  return {
    status: run.status,
    checkedAt: run.startedAt,
    stale: ageMs(run, now) > STALE_AFTER_MS,
    failing: idsWithStatus(run, 'fail'),
    warnings: idsWithStatus(run, 'warn'),
  };
}
