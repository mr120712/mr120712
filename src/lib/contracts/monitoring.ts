// @polsia:user-owned — contratto condiviso del monitoraggio automatico: route /api/status,
// /api/admin/monitoring e la pagina /admin/monitoraggio importano gli stessi schemi.
import { z } from 'zod';

/** Every internal check, in display order. Labels and help texts: src/lib/monitoring/catalog.ts. */
export const MONITOR_CHECK_IDS = [
  'database',
  'signup_write',
  'auth_config',
  'google_signin',
  'youtube_quota',
  'youtube_search',
  'audius',
  'radio',
  'podcasts',
  'jamendo',
  'email',
  'anthropic',
  'stripe',
  'cron_cleanup',
] as const;

export const MonitorCheckIdSchema = z.enum(MONITOR_CHECK_IDS);
/** ok = works; warn = not configured or slow, never alerts; fail = broken, alerts. */
export const MonitorCheckStatusSchema = z.enum(['ok', 'warn', 'fail']);
/** down = a critical check fails; degraded = another check fails; ok otherwise (warnings allowed). */
export const MonitorOverallStatusSchema = z.enum(['ok', 'degraded', 'down']);
/** Who started the run: the public status endpoint, the daily Vercel cron or an admin. */
export const MonitorTriggerSchema = z.enum(['status', 'cron', 'admin']);

export const MonitorCheckResultSchema = z.object({
  id: MonitorCheckIdSchema,
  status: MonitorCheckStatusSchema,
  /** Short Italian explanation. Never secrets, tokens or raw upstream response bodies. */
  detail: z.string().max(300),
  ms: z.number().int().nonnegative(),
});

export const MonitorRunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  status: MonitorOverallStatusSchema,
  trigger: MonitorTriggerSchema,
  results: z.array(MonitorCheckResultSchema),
});

export const MonitorRunSummarySchema = MonitorRunSchema.pick({
  id: true,
  startedAt: true,
  durationMs: true,
  status: true,
  trigger: true,
}).extend({ failing: z.array(MonitorCheckIdSchema) });

export const MonitorHeartbeatSchema = z.object({
  name: z.string(),
  at: z.string(),
  detail: z.string().nullable(),
});

/** GET /api/status (public): ids only, no details. */
export const PublicMonitorStatusSchema = z.object({
  status: z.union([MonitorOverallStatusSchema, z.literal('unknown')]),
  checkedAt: z.string().nullable(),
  /** The latest run is older than two hours (checks could not run again). */
  stale: z.boolean(),
  failing: z.array(MonitorCheckIdSchema),
  warnings: z.array(MonitorCheckIdSchema),
});

/** GET /api/admin/monitoring. */
export const AdminMonitoringSchema = z.object({
  latest: MonitorRunSchema.nullable(),
  /** Newest first, at most 48 runs. */
  history: z.array(MonitorRunSummarySchema),
  heartbeats: z.array(MonitorHeartbeatSchema),
});

/** POST /api/admin/monitoring ("Controlla ora"). */
export const AdminMonitorRunResponseSchema = z.object({ run: MonitorRunSchema });

export type MonitorCheckId = z.infer<typeof MonitorCheckIdSchema>;
export type MonitorCheckStatus = z.infer<typeof MonitorCheckStatusSchema>;
export type MonitorOverallStatus = z.infer<typeof MonitorOverallStatusSchema>;
export type MonitorTrigger = z.infer<typeof MonitorTriggerSchema>;
export type MonitorCheckResult = z.infer<typeof MonitorCheckResultSchema>;
export type MonitorRun = z.infer<typeof MonitorRunSchema>;
export type MonitorRunSummary = z.infer<typeof MonitorRunSummarySchema>;
export type MonitorHeartbeat = z.infer<typeof MonitorHeartbeatSchema>;
export type PublicMonitorStatus = z.infer<typeof PublicMonitorStatusSchema>;
export type AdminMonitoring = z.infer<typeof AdminMonitoringSchema>;
