// @polsia:user-owned — contratti delle risposte di /api/telegram/link (mint del codice + stato).
import { z } from 'zod';

/** POST /api/telegram/link → deep-link già pronto da aprire + scadenza (ms epoch) del codice. */
export const TelegramLinkStartSchema = z.object({
  url: z.string().url(),
  expiresAt: z.number().int().positive(),
});
export type TelegramLinkStart = z.infer<typeof TelegramLinkStartSchema>;

/** GET/DELETE /api/telegram/link → stato del collegamento dell'utente loggato. */
export const TelegramLinkStatusSchema = z.object({
  linked: z.boolean(),
  username: z.string().nullable(),
});
export type TelegramLinkStatus = z.infer<typeof TelegramLinkStatusSchema>;
