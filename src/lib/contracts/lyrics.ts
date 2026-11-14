// @polsia:user-owned — contratto condiviso (client + route handler) dei testi dei brani nel player.
// Un testo esiste SOLO dove Solco ha il diritto di mostrarlo: brani in evidenza dichiarati con
// "testo": true in diritti.json, upload degli utenti con il testo confermato dall'autore, file del
// dispositivo dell'ascoltatore (letti nel browser, mai inviati). Mai fonti di terzi.
import { z } from 'zod';
import { LYRICS_MAX_LINE_CHARS, LYRICS_MAX_LINES, sanitizeLyricsLine } from '@/lib/music/lyrics';

/** Percorso della route dei testi (GET ?featured=<pathname> oppure ?upload=<id>). */
export const LYRICS_API_PATH = '/api/music/lyrics';

/** Caratteri massimi del testo di un upload, dopo la normalizzazione. */
export const UPLOAD_LYRICS_MAX_CHARS = 20_000;

/** Riga di credito per fonte. */
export const LYRICS_CREDIT_UPLOAD = "Testo pubblicato dall'autore";
export const LYRICS_CREDIT_LOCAL = 'Dal tuo file';
/**
 * Credito di un brano in evidenza dal "titolare" di diritti.json, pulito come le righe del testo
 * (niente caratteri di controllo, override bidi o invisibili). null se non resta nulla.
 */
export function featuredLyricsCredit(holder: string): string | null {
  const clean = sanitizeLyricsLine(holder);
  return clean === '' ? null : `Testo: ${clean}`;
}

export const LyricsLineSchema = z.object({
  /** Millisecondi dall'inizio del brano; null nel testo semplice. */
  timeMs: z.number().int().nonnegative().max(86_400_000).nullable(),
  text: z.string().max(LYRICS_MAX_LINE_CHARS * 2),
});
export type LyricsLineDto = z.infer<typeof LyricsLineSchema>;

export const LyricsSourceSchema = z.enum(['featured', 'upload', 'local']);
export type LyricsSource = z.infer<typeof LyricsSourceSchema>;

export const LyricsSchema = z.object({
  kind: z.enum(['synced', 'plain']),
  lines: z.array(LyricsLineSchema).min(1).max(LYRICS_MAX_LINES),
  source: LyricsSourceSchema,
  credit: z.string().max(200).nullable(),
});
export type Lyrics = z.infer<typeof LyricsSchema>;

/**
 * Risposta di GET /api/music/lyrics. `lyrics: null` vale sia per "nessun testo" sia per "testo non
 * autorizzato": la risposta è identica, così non rivela che cosa esiste nello store.
 */
export const LyricsResponseSchema = z.object({
  lyrics: LyricsSchema.nullable(),
});
export type LyricsResponse = z.infer<typeof LyricsResponseSchema>;
