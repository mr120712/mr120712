// @polsia:user-owned — contratto condiviso (client + route) per il pulsante-menu del bot Telegram
// che apre Solco come Mini App.
import { z } from 'zod';

export const TelegramMenuStatusSchema = z.object({
  botConfigured: z.boolean(),
  type: z.string().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  expectedUrl: z.string(),
  matches: z.boolean(),
  lastError: z.string().nullable(),
});
export type TelegramMenuStatus = z.infer<typeof TelegramMenuStatusSchema>;

export const TelegramMenuSetResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  status: TelegramMenuStatusSchema,
});
export type TelegramMenuSetResult = z.infer<typeof TelegramMenuSetResultSchema>;
