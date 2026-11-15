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

/** Le fonti di una copia offline scaricata dal server. */
export const OFFLINE_DOWNLOAD_SOURCES = [
  'audius-download',
  'podcast-download',
  'featured-download',
] as const;
export type OfflineDownloadSource = (typeof OFFLINE_DOWNLOAD_SOURCES)[number];

export const OfflineDownloadMetaSchema = z.object({
  source: z.enum(OFFLINE_DOWNLOAD_SOURCES),
  /**
   * Chiave stabile anti-duplicato (id Audius, 'podcastId~episodeKey' o 'featured:<shareId>' per un
   * brano in evidenza: l'id opaco del link diretto, mai il percorso nello store).
   */
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

// ─── Copie offline dei brani in evidenza: verifica dei permessi ──────────────────────────────
// POST /api/music/featured/offline-status: «La tua musica» chiede, quando è online, quali copie
// offline dei brani in evidenza sono ANCORA consentite da diritti.json. Manda SOLO gli id opachi
// (shareId) delle sue copie in evidenza, mai altri dati dei file sul dispositivo.

/** Id al massimo per richiesta (il client divide in lotti). */
export const FEATURED_OFFLINE_STATUS_MAX_IDS = 100;

/** Prefisso della chiave anti-duplicato di una copia di un brano in evidenza. */
export const FEATURED_DOWNLOAD_KEY_PREFIX = 'featured:';

const FeaturedOfflineIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'Id non valido.');

export const FeaturedOfflineStatusRequestSchema = z
  .object({
    ids: z.array(FeaturedOfflineIdSchema).min(1).max(FEATURED_OFFLINE_STATUS_MAX_IDS),
  })
  .strict();
export type FeaturedOfflineStatusRequest = z.infer<typeof FeaturedOfflineStatusRequestSchema>;

export const FeaturedOfflineStatusResponseSchema = z.object({
  /** Gli id chiesti la cui copia offline è ancora consentita. */
  permitted: z.array(FeaturedOfflineIdSchema).max(FEATURED_OFFLINE_STATUS_MAX_IDS),
  /**
   * Gli id chiesti la cui copia NON è più consentita (revocata, voce tolta o non valida, brano non
   * più nello store, "offline": false): il client toglie quelle copie dal dispositivo. Un id che
   * non compare in nessuno dei due elenchi resta com'è.
   */
  revoked: z.array(FeaturedOfflineIdSchema).max(FEATURED_OFFLINE_STATUS_MAX_IDS),
});
export type FeaturedOfflineStatusResponse = z.infer<typeof FeaturedOfflineStatusResponseSchema>;
