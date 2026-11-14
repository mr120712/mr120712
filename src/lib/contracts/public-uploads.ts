// @polsia:user-owned — contratto condiviso (client + route handler) per la libreria pubblica di
// brani caricati dagli utenti su Vercel Blob. Un cambio di forma diventa errore di tipo/ZodError.
import { z } from 'zod';
import { UPLOAD_LYRICS_MAX_CHARS } from '@/lib/contracts/lyrics';
import { normalizeLyricsInput, parseLyrics } from '@/lib/music/lyrics';

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
  // null quando chi guarda NON può ascoltarlo (serve Premium e non è un suo brano): l'URL del file
  // non lascia mai il server verso un non abbonato.
  streamUrl: blobPublicUrl.nullable(),
  durationSeconds: z.number().int().positive().max(86_400),
  playCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  /** true se il brano è dell'utente che guarda (può rimuoverlo). */
  mine: z.boolean(),
  /** true = pubblicato e verificato (live, puntino verde). false = ritirato/in revisione. */
  published: z.boolean(),
  /**
   * true = chi guarda può ascoltarlo (è un suo brano, oppure ha Premium). I brani pubblicati sono
   * ascoltabili SOLO dagli utenti Premium: per gli altri è false e l'anteprima resta bloccata.
   */
  canPlay: z.boolean(),
  /**
   * Testo del brano (LRC o semplice) così come salvato: SOLO nei brani dell'utente che guarda
   * (elenco "i tuoi brani"), per modificarlo. Assente nella classifica pubblica: lì il testo si
   * legge dal player (GET /api/music/lyrics), e solo se confermato e pubblicato.
   */
  lyrics: z.string().max(UPLOAD_LYRICS_MAX_CHARS).nullable().optional(),
  /** Solo nei brani dell'utente: l'autore ha confermato di avere i diritti sul testo. */
  lyricsRightsConfirmed: z.boolean().optional(),
});
export type PublicUpload = z.infer<typeof PublicUploadSchema>;

/** Caratteri accettati in ingresso prima della normalizzazione (spazi, a capo Windows…). */
const UPLOAD_LYRICS_RAW_MAX_CHARS = UPLOAD_LYRICS_MAX_CHARS * 2;

/** Messaggi dei campi del testo (mostrati sotto il campo, anche quando arrivano dal server). */
export const LYRICS_FIELD_MESSAGES = {
  tooLong: `Il testo è troppo lungo: al massimo ${UPLOAD_LYRICS_MAX_CHARS.toLocaleString('it-IT')} caratteri.`,
  unreadable: 'Il testo non contiene righe leggibili.',
  confirm: 'Conferma che il testo è tuo o che hai il diritto di pubblicarlo.',
} as const;

/** Testo incollato dall'utente: normalizzato (vedi normalizeLyricsInput), '' = nessun testo. */
const uploadLyricsField = z
  .string()
  .max(UPLOAD_LYRICS_RAW_MAX_CHARS, LYRICS_FIELD_MESSAGES.tooLong)
  .transform(normalizeLyricsInput);

/**
 * Regole comuni a creazione e modifica: un testo non vuoto deve stare nel limite, avere almeno una
 * riga leggibile e la conferma dei diritti ("Il testo è mio o ho il diritto di pubblicarlo").
 */
function checkLyricsFields(
  value: { lyrics?: string | null; lyricsRightsConfirmed?: boolean },
  ctx: z.RefinementCtx,
) {
  const text = value.lyrics ?? '';
  if (text === '') return;
  if (text.length > UPLOAD_LYRICS_MAX_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lyrics'],
      message: LYRICS_FIELD_MESSAGES.tooLong,
    });
  } else if (!parseLyrics(text)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lyrics'],
      message: LYRICS_FIELD_MESSAGES.unreadable,
    });
  }
  if (value.lyricsRightsConfirmed !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lyricsRightsConfirmed'],
      message: LYRICS_FIELD_MESSAGES.confirm,
    });
  }
}

export const PublicUploadListResponseSchema = z.object({
  items: z.array(PublicUploadSchema),
});
export type PublicUploadListResponse = z.infer<typeof PublicUploadListResponseSchema>;

/** Corpo inviato per registrare un caricamento già salvato su Blob. */
export const PublicUploadCreateSchema = z
  .object({
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
    /** Testo facoltativo (LRC o semplice): richiede lyricsRightsConfirmed. */
    lyrics: uploadLyricsField.optional(),
    lyricsRightsConfirmed: z.boolean().optional(),
  })
  .superRefine(checkLyricsFields);
export type PublicUploadCreateInput = z.infer<typeof PublicUploadCreateSchema>;

/**
 * Corpo di PATCH /api/music/public-uploads/[uploadId]: l'autore aggiunge, modifica o toglie il
 * testo di un suo brano. `lyrics` null o vuoto = toglie il testo (e la conferma).
 */
export const PublicUploadLyricsUpdateSchema = z
  .object({
    lyrics: uploadLyricsField.nullable(),
    lyricsRightsConfirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine(checkLyricsFields);
export type PublicUploadLyricsUpdate = z.infer<typeof PublicUploadLyricsUpdateSchema>;

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
