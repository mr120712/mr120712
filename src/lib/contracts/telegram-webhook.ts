// @polsia:user-owned — contratto condiviso (client + route) per lo stato/registrazione del webhook
// del bot Telegram interattivo (collegamento account + consegna codice invito).
import { z } from 'zod';

export const TelegramWebhookStatusSchema = z.object({
  /** Bot + secret configurati E webhook registrato sull'URL atteso. */
  ready: z.boolean(),
  botConfigured: z.boolean(),
  secretConfigured: z.boolean(),
  expectedUrl: z.string(),
  currentUrl: z.string().nullable(),
  matches: z.boolean(),
  pendingUpdates: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type TelegramWebhookStatus = z.infer<typeof TelegramWebhookStatusSchema>;

export const TelegramWebhookRegisterResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  status: TelegramWebhookStatusSchema,
});
export type TelegramWebhookRegisterResult = z.infer<typeof TelegramWebhookRegisterResultSchema>;
