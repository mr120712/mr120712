// @polsia:user-owned — contratto della risposta di /api/telegram/link.
import { z } from 'zod';

export const TelegramLinkResponseSchema = z.object({
  token: z.string().min(1).max(512),
});
export type TelegramLinkResponse = z.infer<typeof TelegramLinkResponseSchema>;
