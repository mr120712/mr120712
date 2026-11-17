// @polsia:user-owned — contratto della trascrizione IA dei testi (Whisper) nella pagina admin
// «Diritti e testi»: POST /api/admin/featured-rights/transcribe (bozza LRC), POST
// …/transcribe/align (testo ufficiale allineato ai tempi dell'audio), POST …/transcribe/refine (la
// bozza ripulita dal modello di Solco AI e rimessa sui tempi della bozza) e POST
// /api/admin/featured-rights/transcribe/save (salvataggio del .lrc accanto al brano). Vale SOLO per
// i brani in evidenza dichiarati in diritti.json con "testo": true: per ogni altro brano la
// funzione non esiste (nessun pulsante, il server risponde 404 sempre uguale). La bozza torna solo
// all'amministratore che l'ha chiesta, mai nella cache HTTP; il server la conserva CIFRATA per
// riusarla senza pagare di nuovo OpenAI (fromCache/cachedAt, «regenerate» per rifarla).
// Route e pagina importano gli stessi schemi.
import { z } from 'zod';

/** Il nome del motore di trascrizione di Solco, come lo vede l'amministratore. */
export const SOLCO_AI_NAME = 'Solco AI';

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

/** Dimensione massima del file audio da trascrivere (limite dei servizi Whisper: 25 MB). */
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

/**
 * Giorni dopo i quali una trascrizione conservata (cifrata) e mai riusata si cancella: circa 6
 * mesi. La pulizia giornaliera la toglie, la pagina lo dice.
 */
export const TRANSCRIPTION_CACHE_RETENTION_DAYS = 180;

export const TranscribeRequestSchema = z
  .object({
    pathname: PathnameSchema,
    /** Assente = riconoscimento automatico della lingua. */
    language: TranscriptionLanguageSchema.optional(),
    /**
     * true solo dopo la conferma «Usa di nuovo i crediti OpenAI per questo brano?»: ignora la
     * trascrizione conservata e la rifà (poi la sostituisce). Assente = si riusa se c'è.
     */
    regenerate: z.boolean().optional(),
  })
  .strict();
export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

/** Esito dell'allineamento del testo ufficiale alle parole con tempo (…/transcribe/align). */
export const AlignmentStatsSchema = z
  .object({
    /** Quota (0-1) delle parole del testo con un tempo preso dall'audio; le altre sono interpolate. */
    coverage: z.number().min(0).max(1),
    matchedWords: z.number().int().nonnegative(),
    totalWords: z.number().int().nonnegative(),
    /** Righe del risultato (1 = la prima) con poche parole abbinate: da controllare per prime. */
    unmatchedLines: z
      .array(z.number().int().positive().max(TRANSCRIPTION_LRC_MAX_LINES))
      .max(TRANSCRIPTION_LRC_MAX_LINES),
  })
  .strict();
export type AlignmentStats = z.infer<typeof AlignmentStatsSchema>;

/**
 * Esito di «Rifinisci con Solco AI» (…/transcribe/refine): il testo ripulito dal modello, rimesso
 * sui tempi delle parole della bozza con lo stesso allineamento del testo ufficiale.
 */
export const RefinementStatsSchema = AlignmentStatsSchema.extend({
  /** Righe (non vuote) della bozza prima della rifinitura. */
  linesBefore: z.number().int().nonnegative(),
  /** Righe del testo rifinito. */
  linesAfter: z.number().int().nonnegative(),
}).strict();
export type RefinementStats = z.infer<typeof RefinementStatsSchema>;

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
    /**
     * Righe della bozza (1 = la prima) su cui il modello era poco sicuro (probabilità bassa, dubbio
     * di silenzio o testo ripetitivo): da ascoltare e correggere per prime.
     */
    uncertainLines: z
      .array(z.number().int().positive().max(TRANSCRIPTION_LRC_MAX_LINES))
      .max(TRANSCRIPTION_LRC_MAX_LINES),
    /** true = la bozza ha i tempi parola per parola (tag "<mm:ss.xx>", karaoke nel player). */
    wordTimed: z.boolean(),
    /** true = trascrizione conservata (cifrata) sul server: nessuna chiamata al motore. */
    fromCache: z.boolean(),
    /**
     * Quando la trascrizione è stata conservata cifrata sul server (ISO). Con fromCache false:
     * null se il server non ha la conferma di averla conservata (database giù o lento: la
     * prossima richiesta potrebbe pagarla di nuovo).
     */
    cachedAt: z.string().datetime().nullable(),
    /**
     * Il motore che ha trascritto, senza segreti («Solco AI (Groq · whisper-large-v3)», «Deepgram
     * (nova-3)»): Solco AI prova i motori configurati in ordine e passa al successivo se uno non
     * risponde. Assente per le bozze conservate da versioni precedenti.
     */
    engine: z.string().max(120).optional(),
    /**
     * Solo da POST …/transcribe/align: la bozza è il testo UFFICIALE fornito dall'admin con i tempi
     * presi dall'audio (allineamento), con la copertura e le righe senza riscontro.
     */
    aligned: AlignmentStatsSchema.optional(),
    /**
     * Solo dopo «Rifinisci con Solco AI» (la pagina lo aggiunge alla bozza): parole e versi ripuliti
     * dal modello, tempi presi dalla bozza di prima, con la copertura e le righe senza riscontro.
     */
    refined: RefinementStatsSchema.optional(),
  })
  .strict();
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

/** La bozza da rifinire: al massimo come il .lrc salvato. */
export const REFINE_LRC_MAX_CHARS = TRANSCRIPTION_LRC_MAX_BYTES;

/**
 * POST /api/admin/featured-rights/transcribe/refine («Rifinisci con Solco AI»): la bozza
 * dell'editor (LRC con i tempi, anche parola per parola) ripulita dal modello di Solco AI —
 * punteggiatura, maiuscole, versi ricomposti, errori evidenti di riconoscimento — SENZA inventare
 * né togliere parole, e rimessa sui tempi della bozza. Stesso cancello della trascrizione (solo
 * brani dichiarati con "testo": true: 404 uguale per gli altri). La bozza inviata non si conserva.
 * Errori sul campo `lrc` (400: bozza vuota, senza tempi o troppo lunga); 503 se la chiave Anthropic
 * manca o il modello è occupato; 502 se il modello rifiuta o cambia troppo il testo (la bozza resta
 * com'era).
 */
export const RefineLyricsRequestSchema = z
  .object({
    pathname: PathnameSchema,
    /** La bozza dell'editor: LRC sincronizzato (tempi delle righe o delle parole). */
    lrc: z.string().min(1).max(REFINE_LRC_MAX_CHARS),
    /** Lingua del brano scelta nella pagina (assente = quella del testo). */
    language: TranscriptionLanguageSchema.optional(),
    /** Durata del brano (dalla bozza): i tempi interpolati in coda non la superano. */
    durationSeconds: z.number().nonnegative().max(36_000).optional(),
  })
  .strict();
export type RefineLyricsRequest = z.infer<typeof RefineLyricsRequestSchema>;

export const RefineLyricsResponseSchema = z
  .object({
    /** La bozza rifinita (Enhanced LRC se la bozza aveva i tempi delle parole). */
    draft: z.string().max(TRANSCRIPTION_LRC_MAX_BYTES),
    lineCount: z.number().int().nonnegative(),
    wordTimed: z.boolean(),
    refined: RefinementStatsSchema,
  })
  .strict();
export type RefineLyricsResponse = z.infer<typeof RefineLyricsResponseSchema>;

/** Nota nell'editor per una bozza rifinita dal modello. */
export const TRANSCRIPTION_REFINED_HINT =
  'Parole e versi ripuliti da Solco AI, tempi della bozza di prima: controlla per prime le righe senza riscontro e, se qualcosa non ti torna, «Ripristina la bozza di prima».';

/** Senza la chiave Anthropic la rifinitura è spenta (503 e nota nella pagina). */
export const REFINE_NOT_CONFIGURED_MESSAGE =
  'Aggiungi su Vercel la chiave ANTHROPIC_API_KEY per «Rifinisci con Solco AI»: la trascrizione funziona lo stesso.';

/** Il testo ufficiale da allineare: al massimo come il .lrc salvato. */
export const ALIGN_LYRICS_MAX_CHARS = TRANSCRIPTION_LRC_MAX_BYTES;

/**
 * POST /api/admin/featured-rights/transcribe/align: il testo ufficiale del brano (una riga per
 * verso; anche un LRC: contano solo le parole) allineato alle parole con tempo riconosciute da
 * Solco AI (trascrizione conservata, o nuova con il testo come suggerimento al modello). Risposta:
 * TranscribeResponse con `aligned`. Errori sul campo `lyrics` (400: testo vuoto, troppo lungo o
 * senza riscontro nell'audio); gli altri come la trascrizione (404 brano non ammesso, 503, 429…).
 */
export const AlignLyricsRequestSchema = z
  .object({
    pathname: PathnameSchema,
    lyrics: z.string().min(1).max(ALIGN_LYRICS_MAX_CHARS),
    /** Assente = riconoscimento automatico della lingua (solo per una trascrizione nuova). */
    language: TranscriptionLanguageSchema.optional(),
  })
  .strict();
export type AlignLyricsRequest = z.infer<typeof AlignLyricsRequestSchema>;

/** Nota nell'editor per una bozza allineata al testo fornito. */
export const TRANSCRIPTION_ALIGNED_HINT =
  'Parole del tuo testo, tempi di Solco AI: controlla per prime le righe senza riscontro nell’audio.';

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
/** Nota nell'editor quando la bozza ha i tempi delle parole. */
export const TRANSCRIPTION_WORD_TAG_HINT =
  'Tempi parola per parola: i tag <mm:ss.xx> davanti alle parole fanno il karaoke nel player. Correggi le parole e lascia i tag.';
/**
 * Senza nessuna chiave di un motore la trascrizione è spenta (stesso testo nella pagina e nel 503).
 * Basta UNA di queste variabili su Vercel; con più chiavi Solco AI passa da un motore all'altro.
 */
export const TRANSCRIPTION_NOT_CONFIGURED_MESSAGE =
  'Aggiungi su Vercel la chiave di un motore per Solco AI (trascrizione dei testi): GROQ_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, OPENAI_API_KEY, FIREWORKS_API_KEY, MISTRAL_API_KEY oppure CLOUDFLARE_API_TOKEN (CLOUDFLARE_ACCOUNT_ID solo se il token vede più account)';

/**
 * POST /api/admin/featured-rights/transcribe/check («Verifica Solco AI»): il motore di trascrizione
 * provato con la stessa richiesta della trascrizione su un secondo di silenzio generato sul server.
 * Un errore ha la forma delle altre route ({ error, message }): transcription_not_configured (503)
 * se la chiave manca su Vercel; transcription_invalid_key (502), transcription_no_credit (402:
 * crediti finiti o fatturazione non attiva), transcription_rate_limited (429),
 * transcription_unavailable e transcription_no_response (502) se il servizio rifiuta o non
 * risponde. Il messaggio è sempre italiano, mai la chiave.
 */
/** L'esito della prova di UN motore (tutti i motori configurati si provano insieme). */
export const TranscriptionEngineProbeSchema = z
  .object({
    /** Identificatore del motore: groq, deepgram, elevenlabs, openai, fireworks, mistral, cloudflare. */
    id: z.string().min(1).max(20),
    /** Motore senza segreti, es. «Deepgram (nova-3)». */
    label: z.string().min(1).max(120),
    ok: z.boolean(),
    /** Millisecondi impiegati dal servizio per rispondere (o per fallire). */
    elapsedMs: z.number().int().nonnegative(),
    /** Perché non funziona (italiano, senza chiave né testo del servizio); null se funziona. */
    message: z.string().max(600).nullable(),
  })
  .strict();
export type TranscriptionEngineProbe = z.infer<typeof TranscriptionEngineProbeSchema>;

export const TranscriptionCheckResponseSchema = z
  .object({
    ok: z.literal(true),
    /** Modello del primo motore che ha risposto, es. "whisper-large-v3". */
    model: z.string().min(1).max(60),
    /** Primo motore funzionante senza segreti, es. «Solco AI (Groq · whisper-large-v3)». */
    engine: z.string().min(1).max(120),
    /** Millisecondi impiegati da quel motore per rispondere. */
    elapsedMs: z.number().int().nonnegative(),
    checkedAt: z.string().datetime(),
    /** Tutti i motori configurati con il loro esito, nell'ordine in cui la trascrizione li prova. */
    engines: z.array(TranscriptionEngineProbeSchema).min(1).max(10),
  })
  .strict();
export type TranscriptionCheckResponse = z.infer<typeof TranscriptionCheckResponseSchema>;
/** Avviso di «Verifica Solco AI» quando la prova riesce. */
export const TRANSCRIPTION_CHECK_SUCCESS = 'Solco AI funziona: trascrizione dei testi pronta';
