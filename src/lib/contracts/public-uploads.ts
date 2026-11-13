// @polsia:user-owned — contratto condiviso (client + route handler) per la libreria pubblica di
// brani caricati dagli utenti su AWS S3. Un cambio di forma diventa errore di tipo/ZodError.
import { z } from 'zod';

/** Tipo MIME audio di base, senza parametri. */
export const audioMimeType = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^audio\/[a-z0-9][a-z0-9.+-]{0,40}$/, 'Tipo audio non valido.');

/**
 * URL pubblico di un oggetto di storage. Solo https e host di uno storage noto: AWS S3
 * (*.amazonaws.com), CloudFront (*.cloudfront.net) o Vercel Blob (*.blob.vercel-storage.com, per i
 * brani caricati prima della migrazione). Questo URL è prodotto dal SERVER (mai dal client).
 */
export const storagePublicUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:') return false;
        const host = url.hostname;
        return (
          host.endsWith('.amazonaws.com') ||
          host.endsWith('.cloudfront.net') ||
          host.endsWith('.blob.vercel-storage.com')
        );
      } catch {
        return false;
      }
    },
    { message: 'URL del file non valido.' },
  );

/** Chiave dell'oggetto su S3: deve stare nel prefisso consentito. */
export const publicUploadKey = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^public-uploads\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$/, 'Percorso del file non valido.');

const MAX_BYTES = 40 * 1024 * 1024;

/** Quello che vede il client per un brano pubblico. `streamUrl` è l'URL pubblico su S3/CDN. */
export const PublicUploadSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  artist: z.string().max(120).nullable(),
  streamUrl: storagePublicUrl,
  durationSeconds: z.number().int().positive().max(86_400),
  playCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  /** true se il brano è dell'utente che guarda (può rimuoverlo). */
  mine: z.boolean(),
  /** true = pubblicato e verificato (live, puntino verde). false = ritirato/in revisione. */
  published: z.boolean(),
});
export type PublicUpload = z.infer<typeof PublicUploadSchema>;

export const PublicUploadListResponseSchema = z.object({
  items: z.array(PublicUploadSchema),
});
export type PublicUploadListResponse = z.infer<typeof PublicUploadListResponseSchema>;

/** Richiesta di un URL PUT firmato: il server sceglie la chiave e firma l'upload. */
export const PublicUploadPresignRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  fileName: z.string().trim().min(1).max(260),
  contentType: audioMimeType,
  byteLength: z.number().int().positive().max(MAX_BYTES),
});
export type PublicUploadPresignRequest = z.infer<typeof PublicUploadPresignRequestSchema>;

/** Risposta: URL PUT firmato, la chiave scelta dal server e il content-type da usare nel PUT. */
export const PublicUploadPresignResponseSchema = z.object({
  uploadUrl: z.string().url(),
  key: publicUploadKey,
  contentType: audioMimeType,
});
export type PublicUploadPresignResponse = z.infer<typeof PublicUploadPresignResponseSchema>;

/** Corpo inviato per registrare un caricamento già messo su S3 (si manda la CHIAVE, non un URL). */
export const PublicUploadCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().max(120).optional(),
  key: publicUploadKey,
  mimeType: audioMimeType,
  byteLength: z.number().int().positive().max(MAX_BYTES),
  // Durata misurata dal client: fallback se il contenitore non la riporta.
  elapsedSeconds: z.number().int().positive().max(86_400),
});
export type PublicUploadCreateInput = z.infer<typeof PublicUploadCreateSchema>;

export const PublicUploadCreateResponseSchema = z.object({
  upload: PublicUploadSchema,
});
export type PublicUploadCreateResponse = z.infer<typeof PublicUploadCreateResponseSchema>;

export const PublicUploadMineResponseSchema = z.object({
  items: z.array(PublicUploadSchema),
});

export const MAX_PUBLIC_UPLOAD_BYTES = MAX_BYTES;

/** Quanti brani può pubblicare al massimo un utente nella libreria pubblica. */
export const PUBLIC_UPLOAD_MAX_PER_USER = 3;
