// @polsia:user-owned — contratto del «Bot Solco» (POST /api/bot/command): l'utente invia una
// ricerca, il bot risponde con brani Creative Commons / radio / podcast riproducibili nel player
// (riusa UnifiedResultSchema) e con lo stato della quota mensile (30 ricerche per gli account free).
import { z } from 'zod';
import { UnifiedResultSchema } from '@/lib/contracts/unified-search';

export const BOT_QUERY_MAX = 80;

export const BotCommandRequestSchema = z.object({
  query: z.string().trim().min(1).max(BOT_QUERY_MAX),
});
export type BotCommandRequest = z.infer<typeof BotCommandRequestSchema>;

/** Stato della quota: limit/remaining sono null per i Premium (illimitati). */
export const BotQuotaSchema = z.object({
  premium: z.boolean(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
});
export type BotQuota = z.infer<typeof BotQuotaSchema>;

export const BotCommandResponseSchema = BotQuotaSchema.extend({
  query: z.string().min(1),
  results: z.array(UnifiedResultSchema),
});
export type BotCommandResponse = z.infer<typeof BotCommandResponseSchema>;
