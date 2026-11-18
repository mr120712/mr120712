// @polsia:user-owned — contratto condiviso (route + pannello) di «Skynet», la sentinella che ogni
// minuto guarda Solco (src/lib/skynet/). Mai segreti: del token Vercel si sa solo se c'è.
import { z } from 'zod';
import { PQ_RESULTS } from '@/lib/skynet/quantum';

/** Motore post-quantistico: i domini accettano lo scambio di chiavi X25519MLKEM768? */
export const SkynetQuantumSchema = z.object({
  checkedAt: z.string(),
  pq: z.boolean().nullable(),
  group: z.string(),
  hosts: z.array(z.object({ host: z.string(), result: z.enum(PQ_RESULTS) })),
  refused: z.number().int().nonnegative(),
  announced: z.enum(['on', 'off']).nullable(),
});

export const SkynetSignalsSchema = z.object({
  at: z.string(),
  vercel: z.object({
    configured: z.boolean(),
    reachable: z.boolean().nullable(),
    anomalies: z.number().int().nonnegative().nullable(),
    firewallEnabled: z.boolean().nullable(),
    firewallVersion: z.number().int().nullable(),
    aiBotsActive: z.boolean().nullable(),
    skynetRulesActive: z.number().int().nonnegative().nullable(),
    attackMode: z.boolean().nullable(),
    /** Recidivi rimandati alla verifica del browser (regole IP create da Skynet). */
    // I segnali salvati prima del cacciatore non hanno il campo: valgono null.
    hunted: z.number().int().nonnegative().nullable().optional(),
    /** Di questi, quelli con la verifica prolungata (7 o 30 giorni). */
    huntedLong: z.number().int().nonnegative().nullable().optional(),
  }),
  site: z.object({
    healthOk: z.boolean(),
    healthStatus: z.number().int().nullable(),
    healthMs: z.number().int().nonnegative().nullable(),
    internal: z.enum(['ok', 'degraded', 'down', 'unknown']),
    internalFailing: z.array(z.string()),
  }),
  // I segnali salvati prima del motore post-quantistico non hanno il campo.
  quantum: SkynetQuantumSchema.nullable().optional(),
});

export const SkynetEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(['incident', 'update', 'reminder', 'resolved', 'change', 'hunt', 'quantum']),
  severity: z.enum(['critical', 'warning', 'info']),
  title: z.string(),
  report: z.string(),
  keys: z.array(z.string()),
  notified: z.number().int().nonnegative(),
});

export const SkynetOverviewSchema = z.object({
  /** never = nessun giro ancora (prima esecuzione del cron dopo il deploy). */
  status: z.enum(['calm', 'incident', 'never']),
  lastRunAt: z.string().nullable(),
  incidentSince: z.string().nullable(),
  incidentKeys: z.array(z.string()),
  signals: SkynetSignalsSchema.nullable(),
  configured: z.object({
    vercel: z.boolean(),
    telegramRecipients: z.number().int().nonnegative(),
    ai: z.boolean(),
  }),
  events: z.array(SkynetEventSchema),
});

export type SkynetOverview = z.infer<typeof SkynetOverviewSchema>;
export type SkynetEventView = z.infer<typeof SkynetEventSchema>;
