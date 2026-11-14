// @polsia:user-owned — contratto della trascrizione IA dei testi (Whisper) nella pagina admin
// «Diritti e testi»: POST /api/admin/featured-rights/transcribe (bozza LRC) e POST
// /api/admin/featured-rights/transcribe/save (salvataggio del .lrc accanto al brano). Vale SOLO per
// i brani in evidenza dichiarati in diritti.json con "testo": true: per ogni altro brano la
// funzione non esiste (nessun pulsante, il server risponde 404 sempre uguale). La bozza torna solo
// all'amministratore che l'ha chiesta, mai in cache. Route e pagina importano gli stessi schemi.
import { z } from 'zod';

/** Formati audio che Whisper accetta (dall'estensione del file). Gli altri si rifiutano. */
export const WHISPER_EXTENSIONS = [
  'flac',
  'm4a',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'oga',
  'ogg',
  'wav',
  'webm',
] as const;
export type WhisperExtension = (typeof WHISPER_EXTENSIONS)[number];

/** Dimensione massima del file audio da trascrivere (limite di OpenAI: 25 MB). */
export const TRANSCRIPTION_MAX_AUDIO_BYTES = 25 * 1000 * 1000;
/** Dimensione massima del .lrc salvato (come i file di testo letti dal player). */
export const TRANSCRIPTION_LRC_MAX_BYTES = 64 * 1024;
/** Righe di testo (non vuote) al massimo nel .lrc salvato. */
export const TRANSCRIPTION_LRC_MAX_LINES = 1000;
/** Caratteri al massimo per riga del .lrc salvato (tempi compresi). */
export const TRANSCRIPTION_LRC_MAX_LINE_CHARS = 1000;
/** Minuti entro cui un .lrc nuovo compare nel player (l'indice dei brani si rilegge ogni ~5). */
export const TRANSCRIPTION_VISIBLE_WITHIN_MINUTES = 5;

/** Lingue proposte nella pagina (ISO-639-1). Senza lingua Whisper la riconosce da solo. */
export const TRANSCRIPTION_LANGUAGES = [
  { code: 'it', label: 'Italiano' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
] as const;

export const TranscriptionLanguageSchema = z.enum(['it', 'en', 'es', 'fr', 'de', 'pt']);
export type TranscriptionLanguage = z.infer<typeof TranscriptionLanguageSchema>;

/**
 * Il pathname è solo un testo qui: se non è un brano in evidenza ammesso (percorso non sicuro,
 * non audio, non dichiarato, senza "testo": true, file assente) il server risponde 404, sempre
 * nello stesso modo.
 */
const PathnameSchema = z.string().max(2048);

export const TranscribeRequestSchema = z
  .object({
    pathname: PathnameSchema,
    /** Assente = riconoscimento automatico della lingua. */
    language: TranscriptionLanguageSchema.optional(),
  })
  .strict();
export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

export const TranscribeResponseSchema = z
  .object({
    /** Bozza LRC: una riga "[mm:ss.xx] testo" per segmento riconosciuto. */
    draft: z.string().max(TRANSCRIPTION_LRC_MAX_BYTES),
    /** Righe della bozza come le legge il player. */
    lineCount: z.number().int().nonnegative(),
    /** Lingua riconosciuta da Whisper (es. "italian"), se c'è. */
    language: z.string().max(40).nullable(),
    durationSeconds: z.number().nonnegative().nullable(),
    /** Segmenti scartati come allucinazioni (crediti dei sottotitoli, silenzio). */
    droppedSegments: z.number().int().nonnegative(),
  })
  .strict();
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

export const SaveLyricsRequestSchema = z
  .object({
    pathname: PathnameSchema,
    /** Il testo da salvare (LRC o semplice). Oltre 64 KB si rifiuta. */
    lrc: z.string().max(TRANSCRIPTION_LRC_MAX_BYTES * 4),
    /** true solo dopo la conferma esplicita di sostituire un .lrc che c'è già. */
    overwrite: z.boolean(),
  })
  .strict();
export type SaveLyricsRequest = z.infer<typeof SaveLyricsRequestSchema>;

export const SaveLyricsResponseSchema = z
  .object({
    saved: z.literal(true),
    visibleWithinMinutes: z.literal(TRANSCRIPTION_VISIBLE_WITHIN_MINUTES),
  })
  .strict();
export type SaveLyricsResponse = z.infer<typeof SaveLyricsResponseSchema>;

/**
 * Lingue che Whisper riconosce, per nome inglese (come le restituisce verbose_json) → codice
 * ISO-639 (per mostrarne il nome in italiano con Intl.DisplayNames).
 */
const WHISPER_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  afrikaans: 'af',
  albanian: 'sq',
  amharic: 'am',
  arabic: 'ar',
  armenian: 'hy',
  assamese: 'as',
  azerbaijani: 'az',
  bashkir: 'ba',
  basque: 'eu',
  belarusian: 'be',
  bengali: 'bn',
  bosnian: 'bs',
  breton: 'br',
  bulgarian: 'bg',
  burmese: 'my',
  cantonese: 'yue',
  castilian: 'es',
  catalan: 'ca',
  chinese: 'zh',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  estonian: 'et',
  faroese: 'fo',
  finnish: 'fi',
  flemish: 'nl',
  french: 'fr',
  galician: 'gl',
  georgian: 'ka',
  german: 'de',
  greek: 'el',
  gujarati: 'gu',
  haitian: 'ht',
  'haitian creole': 'ht',
  hausa: 'ha',
  hawaiian: 'haw',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  icelandic: 'is',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  javanese: 'jv',
  kannada: 'kn',
  kazakh: 'kk',
  khmer: 'km',
  korean: 'ko',
  lao: 'lo',
  latin: 'la',
  latvian: 'lv',
  letzeburgesch: 'lb',
  lingala: 'ln',
  lithuanian: 'lt',
  luxembourgish: 'lb',
  macedonian: 'mk',
  malagasy: 'mg',
  malay: 'ms',
  malayalam: 'ml',
  maltese: 'mt',
  mandarin: 'zh',
  maori: 'mi',
  marathi: 'mr',
  moldavian: 'ro',
  moldovan: 'ro',
  mongolian: 'mn',
  myanmar: 'my',
  nepali: 'ne',
  norwegian: 'no',
  nynorsk: 'nn',
  occitan: 'oc',
  panjabi: 'pa',
  pashto: 'ps',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  punjabi: 'pa',
  pushto: 'ps',
  romanian: 'ro',
  russian: 'ru',
  sanskrit: 'sa',
  serbian: 'sr',
  shona: 'sn',
  sindhi: 'sd',
  sinhala: 'si',
  sinhalese: 'si',
  slovak: 'sk',
  slovenian: 'sl',
  somali: 'so',
  spanish: 'es',
  sundanese: 'su',
  swahili: 'sw',
  swedish: 'sv',
  tagalog: 'tl',
  tajik: 'tg',
  tamil: 'ta',
  tatar: 'tt',
  telugu: 'te',
  thai: 'th',
  tibetan: 'bo',
  turkish: 'tr',
  turkmen: 'tk',
  ukrainian: 'uk',
  urdu: 'ur',
  uzbek: 'uz',
  valencian: 'ca',
  vietnamese: 'vi',
  welsh: 'cy',
  yiddish: 'yi',
  yoruba: 'yo',
};

/**
 * Codice ISO-639 della lingua riconosciuta da Whisper (nome inglese come "italian", o già un
 * codice come "it"), o null se sconosciuta.
 */
export function whisperLanguageCode(value: string | null | undefined): string | null {
  const name = value?.trim().toLowerCase() ?? '';
  if (Object.hasOwn(WHISPER_LANGUAGE_CODES, name)) return WHISPER_LANGUAGE_CODES[name] ?? null;
  return Object.values(WHISPER_LANGUAGE_CODES).includes(name) ? name : null;
}

/** Messaggio del 409 quando c'è già un .lrc e la sostituzione non è stata confermata. */
export const LRC_EXISTS_MESSAGE = 'Esiste già un .lrc: conferma per sostituirlo';
/** Senza chiave OpenAI la trascrizione è spenta (stesso testo nella pagina e nel 503). */
export const TRANSCRIPTION_NOT_CONFIGURED_MESSAGE =
  'Aggiungi OPENAI_API_KEY su Vercel per usare la trascrizione';
