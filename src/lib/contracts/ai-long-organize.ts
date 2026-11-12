// @polsia:user-owned — contratto di "Organizza con l'AI": Claude Opus 5.5 legge un testo lungo e
// disordinato (una scaletta di concerto, una classifica di fine anno, l'export di una chat, un
// thread di forum) usando la sua finestra da 1M token e ne estrae un elenco pulito di brani
// (titolo + artista), in ordine e senza doppioni. L'elenco alimenta poi l'importazione dell'elenco
// brani esistente (righe "Artista - Titolo").
import { z } from 'zod';
import { TRACK_LIST_MAX_TRACKS } from '@/lib/business/track-list-import';

export const AI_ORGANIZE_TEXT_MIN = 20;
// 4 MB di corpo della richiesta ≈ 1M token di testo: questo tetto sui caratteri è solo un limite
// strutturale. Il vero limite di spesa è il conteggio dei token lato server
// (SOLCO_AI_LONG_MAX_INPUT_TOKENS, default 400.000), misurato con count_tokens prima della chiamata.
export const AI_ORGANIZE_TEXT_MAX = 4_000_000;
export const AI_ORGANIZE_NAME_MAX = 80;

/** Numero massimo di brani estratti: lo stesso tetto dell'importazione dell'elenco brani. */
export const AI_ORGANIZE_MAX_TRACKS = TRACK_LIST_MAX_TRACKS;

export const AiOrganizeRequestSchema = z.object({
  text: z
    .string()
    .min(
      AI_ORGANIZE_TEXT_MIN,
      `Incolla un testo un po' più lungo (almeno ${AI_ORGANIZE_TEXT_MIN} caratteri).`,
    )
    .max(AI_ORGANIZE_TEXT_MAX, 'Il testo è troppo lungo: riducilo e riprova.'),
  name: z
    .string()
    .trim()
    .max(AI_ORGANIZE_NAME_MAX, `Massimo ${AI_ORGANIZE_NAME_MAX} caratteri.`)
    .optional(),
});
export type AiOrganizeRequest = z.infer<typeof AiOrganizeRequestSchema>;

export const OrganizedTrackSchema = z.object({
  title: z.string().min(1).max(200),
  /** Artista principale; stringa vuota quando il testo non lo indica. */
  artist: z.string().max(200),
});
export type OrganizedTrack = z.infer<typeof OrganizedTrackSchema>;

export const AiOrganizeResultSchema = z.object({
  tracks: z.array(OrganizedTrackSchema),
  /** Righe "Artista - Titolo" (una per brano) pronte per l'importazione dell'elenco brani. */
  trackListText: z.string(),
  /** Una frase dell'AI su cosa ha estratto, oppure null. */
  note: z.string().nullable(),
  /** Token in ingresso misurati con count_tokens prima della chiamata. */
  inputTokens: z.number().int().nonnegative(),
  /** Costo approssimativo della chiamata in dollari (input + output effettivi). */
  approxUsd: z.number().nonnegative(),
  /** Brani validi oltre il limite di AI_ORGANIZE_MAX_TRACKS, scartati. */
  truncated: z.number().int().nonnegative(),
});
export type AiOrganizeResult = z.infer<typeof AiOrganizeResultSchema>;

/** Corpo di errore della route: `inputTokens`/`maxInputTokens` solo quando il testo supera il tetto. */
export const AiOrganizeErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  maxInputTokens: z.number().int().nonnegative().optional(),
});
export type AiOrganizeError = z.infer<typeof AiOrganizeErrorSchema>;

/** Cosa dice GET al client: se il pulsante è attivo e se l'utente può usarlo (solo piani a pagamento). */
export const AiOrganizeStatusSchema = z.object({
  enabled: z.boolean(),
  signedIn: z.boolean(),
  premium: z.boolean(),
});
