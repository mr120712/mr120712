// @polsia:user-owned — contratto condiviso di "Scarica da URL" (client + rotta). Il client POSTa un
// URL; la rotta risponde col file in allegato (binario) o con un errore JSON di questa forma.
import { z } from 'zod';

/** Un link reale sta ben sotto: tetto per rifiutare subito input abnormi. Deve combaciare col server. */
export const MAX_DOWNLOAD_URL_LENGTH = 2048;

export const DownloadByUrlRequestSchema = z.object({
  url: z.string().trim().min(1).max(MAX_DOWNLOAD_URL_LENGTH),
});
export type DownloadByUrlRequest = z.infer<typeof DownloadByUrlRequestSchema>;

/** Corpo di errore (le risposte di successo sono binarie, non JSON). */
export const DownloadByUrlErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  retryAfterSeconds: z.number().optional(),
});
export type DownloadByUrlError = z.infer<typeof DownloadByUrlErrorSchema>;
