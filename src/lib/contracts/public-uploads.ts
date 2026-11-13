// @polsia:user-owned — contratto condiviso (client + route handler) per la libreria pubblica di
// brani caricati dagli utenti su Vercel Blob. Un cambio di forma diventa errore di tipo/ZodError.
import { z } from 'zod';

/** Tipo MIME audio di base, senza parametri. */
export const audioMimeType = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^audio\/[a-z0-9][a-z0-9.+-]{0,40}$/, 'Tipo audio non valido.');

/** URL pubblico di un oggetto su Vercel Blob. Solo https e host *.blob.vercel-storage.com. */
export const blobPublicUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.endsWith('.blob.vercel-storage.com');
      } catch {
        return false;
      }
    },
    { message: 'URL del file non valido.' },
  );

const MAX_BYTES = 40 * 1024 * 1024;

/** Quello che vede il client per un brano pubblico. `streamUrl` è l'URL pubblico su Blob. */
export const PublicUploadSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  artist: z.string().max(120).nullable(),
  streamUrl: blobPublicUrl,
  durationSeconds: z.number().int().positive().max(86_400),
  playCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  /** true se il brano è dell'utente che guarda (può rimuoverlo). */
  mine: z.boolean(),
});
export type PublicUpload = z.infer<typeof PublicUploadSchema>;

export const PublicUploadListResponseSchema = z.object({
  items: z.array(PublicUploadSchema),
});
export type PublicUploadListResponse = z.infer<typeof PublicUploadListResponseSchema>;

/** Corpo inviato per registrare un caricamento già salvato su Blob. */
export const PublicUploadCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  artist: z.string().trim().max(120).optional(),
  blobUrl: blobPublicUrl,
  blobPathname: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$/, 'Percorso del file non valido.'),
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
