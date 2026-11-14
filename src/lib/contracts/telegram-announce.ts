// @polsia:user-owned — contratto condiviso fra la route admin e il pannello per gli annunci build.
import { z } from 'zod';

/** Anteprima (GET): stato della configurazione e testo che verrebbe pubblicato. */
export const AnnouncePreviewSchema = z.object({
  botConfigured: z.boolean(),
  channelConfigured: z.boolean(),
  commitShort: z.string(),
  preview: z.string(),
  alreadyAnnounced: z.boolean(),
});
export type AnnouncePreview = z.infer<typeof AnnouncePreviewSchema>;

/** Esito della pubblicazione manuale (POST). */
export const AnnounceResultSchema = z.object({
  posted: z.boolean(),
  text: z.string(),
  reason: z.enum(['ok', 'telegram_failed', 'bot_not_configured', 'channel_not_configured']),
});
export type AnnounceResult = z.infer<typeof AnnounceResultSchema>;

/** Esito del post dedicato che invita ad aprire il bot (POST). */
export const TelegramBotPostResultSchema = z.object({
  posted: z.boolean(),
  text: z.string(),
  reason: z.enum([
    'ok',
    'telegram_failed',
    'bot_not_configured',
    'channel_not_configured',
    'username_not_configured',
  ]),
});
export type TelegramBotPostResult = z.infer<typeof TelegramBotPostResultSchema>;
