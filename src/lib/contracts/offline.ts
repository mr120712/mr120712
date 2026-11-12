// @polsia:user-owned — contratto condiviso di "Scarica il permesso".
//
// Le rotte di download restituiscono i BYTE audio come corpo (non JSON): i metadati per salvare il
// brano nella libreria viaggiano in un header, OFFLINE_DOWNLOAD_META_HEADER, come JSON in base64
// (così gli accenti italiani restano ASCII nell'header). Il client decodifica l'header, lo valida
// con OfflineDownloadMetaSchema e passa i campi a addDownloadedTrack. In caso di errore le rotte
// restituiscono invece JSON con { error, message }.
import { z } from 'zod';

/** Header che porta i metadati del brano scaricato (JSON in base64). */
export const OFFLINE_DOWNLOAD_META_HEADER = 'x-solco-download';

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Il link deve usare HTTPS.');

export const OfflineAttributionSchema = z.object({
  sourceName: z.string().min(1).max(300).nullable(),
  sourceUrl: httpsUrl.nullable(),
  licenseName: z.string().min(1).max(200).nullable(),
  licenseUrl: httpsUrl.nullable(),
  creditLine: z.string().min(1).max(500).nullable(),
});
export type OfflineAttribution = z.infer<typeof OfflineAttributionSchema>;

export const OfflineDownloadMetaSchema = z.object({
  source: z.enum(['audius-download', 'podcast-download']),
  /** Chiave stabile anti-duplicato (id Audius o 'podcastId~episodeKey'). */
  downloadKey: z.string().min(1).max(300),
  title: z.string().min(1).max(400),
  artist: z.string().min(1).max(300).nullable(),
  album: z.string().min(1).max(300).nullable(),
  durationSeconds: z.number().int().nonnegative().max(86_400).nullable(),
  /** Tipo audio dichiarato dal proxy; il client lo rinormalizza prima di salvare. */
  mimeType: z.string().min(1).max(100),
  attribution: OfflineAttributionSchema,
});
export type OfflineDownloadMeta = z.infer<typeof OfflineDownloadMetaSchema>;

/** Corpo JSON degli errori delle rotte di download. */
export const OfflineDownloadErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type OfflineDownloadError = z.infer<typeof OfflineDownloadErrorSchema>;
