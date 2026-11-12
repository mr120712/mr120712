// @polsia:user-owned — contratti per i brani registrati dall'utente sul sito.
import { z } from 'zod';

/** Tipo MIME audio di base (senza parametri come ";codecs=opus"). */
const audioMimeType = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^audio\/[a-z0-9][a-z0-9.+-]{0,40}$/, 'Tipo audio non valido.');

/** Chiave di un file privato: lettere, cifre, '/', '_', '-', '.'; mai assoluta. */
const privateFileKey = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/, 'Chiave file non valida.');

/** Quello che vede il client: mai la chiave del file privato. */
export const RecordingSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  durationSeconds: z.number().int().positive().max(86_400),
  createdAt: z.string().datetime(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const RecordingListResponseSchema = z.object({
  recordings: z.array(RecordingSchema),
});
export type RecordingListResponse = z.infer<typeof RecordingListResponseSchema>;

/** Corpo della registrazione: la durata autorevole viene ricavata dal server. */
export const RecordingCreateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  fileKey: privateFileKey,
  mimeType: audioMimeType,
  // 40 MB: abbondante per 10 minuti di Opus (~10 MB). Tiene basso il peso di un eventuale
  // oggetto orfano in archivio (vedi deleteRecording: il modulo non espone una delete).
  byteLength: z
    .number()
    .int()
    .positive()
    .max(40 * 1024 * 1024),
  /** Durata misurata dal client (secondi): fallback quando il contenitore non la riporta. */
  elapsedSeconds: z.number().int().positive().max(86_400),
});
export type RecordingCreateInput = z.infer<typeof RecordingCreateSchema>;

export const RecordingCreateResponseSchema = z.object({
  recording: RecordingSchema,
});
