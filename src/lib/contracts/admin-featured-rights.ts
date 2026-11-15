// @polsia:user-owned — contratto della pagina admin «Diritti e testi» (/admin/diritti-testi): la
// route GET /api/admin/featured-rights e la pagina importano gli stessi schemi. È una DIAGNOSI dei
// "brani in evidenza": dice perché un brano è (o non è) ricercabile, se il suo testo è
// disponibile e se la copia offline è consentita, ma NON contiene mai il testo di un brano, nemmeno una riga: per il testo c'è solo
// la fonte, il tipo e il numero di righe. Tutti gli oggetti sono `strict`: un campo in più (per
// esempio le righe del testo aggiunte per sbaglio) fa fallire il parse sul server e sul client.
import { z } from 'zod';

/** Brani al massimo nella risposta (dal più recente). */
export const FEATURED_RIGHTS_MAX_TRACKS = 5000;
/** Voci con problemi al massimo (il manifest ne ammette 5000). */
export const FEATURED_RIGHTS_MAX_PROBLEMS = 5000;
/** Caratteri massimi del valore "file" di una voce con problemi (com'è scritto nel manifest). */
export const FEATURED_RIGHTS_FILE_MAX_CHARS = 300;

const CountSchema = z.number().int().nonnegative();
const ReasonSchema = z.string().min(1).max(400);

export const FeaturedRightsManifestStatusSchema = z.enum([
  /** diritti.json non c'è nella radice dello store. */
  'missing',
  /** C'è ma non vale (JSON, UTF-8, dimensione, struttura): nessun brano ricercabile. */
  'invalid',
  /** Valido: le voci valide rendono ricercabili i brani che esistono. */
  'valid',
  /** Store non configurato o non leggibile: non si sa. */
  'unavailable',
]);

export const FeaturedRightsProblemSchema = z
  .object({
    /** Posizione della voce in "brani", da 1. */
    index: z.number().int().positive(),
    /** Il valore "file" come è scritto (troncato a 300 caratteri), o null se manca. */
    file: z
      .string()
      .max(FEATURED_RIGHTS_FILE_MAX_CHARS + 1)
      .nullable(),
    /** invalid = scartata; ignored = valida ma senza effetto (doppione, file non trovato). */
    kind: z.enum(['invalid', 'ignored']),
    reasons: z.array(ReasonSchema).min(1).max(8),
  })
  .strict();

export const FeaturedRightsManifestSchema = z
  .object({
    status: FeaturedRightsManifestStatusSchema,
    /** Perché il manifest intero non vale o non si legge (vuoto se valido). */
    reasons: z.array(ReasonSchema).max(20),
    /** Riga e colonna dell'errore JSON, se note. */
    location: z
      .object({ line: z.number().int().positive(), column: z.number().int().positive() })
      .strict()
      .nullable(),
    counts: z
      .object({
        entries: CountSchema,
        valid: CountSchema,
        invalid: CountSchema,
        ignored: CountSchema,
      })
      .strict(),
    problems: z.array(FeaturedRightsProblemSchema).max(FEATURED_RIGHTS_MAX_PROBLEMS),
  })
  .strict();

/** Testo trovato: SOLO fonte, tipo e numero di righe (mai le righe). */
const LyricsFoundSchema = z
  .object({
    status: z.enum(['lrc', 'txt', 'embedded']),
    kind: z.enum(['synced', 'plain']),
    lineCount: CountSchema,
    /**
     * Presente (true) solo se la LETTURA di un file accanto è fallita (rete o tempo scaduto) e il
     * testo viene dalla fonte successiva: il file potrebbe essere buono.
     */
    sidecarError: z.literal(true).optional(),
  })
  .strict();

const LyricsNotFoundSchema = z
  .object({
    /**
     * none = nessuna fonte ha un testo; error = lettura fallita; skipped = da controllare (oltre il
     * tetto di controlli per richiesta o il tempo massimo: "Aggiorna"); not_checked = il brano non
     * è dichiarato con "testo": true, quindi il testo non si cerca nemmeno.
     */
    status: z.enum(['none', 'error', 'skipped', 'not_checked']),
  })
  .strict();

export const FeaturedRightsLyricsSchema = z.union([LyricsFoundSchema, LyricsNotFoundSchema]);

/**
 * Copia offline di un brano DICHIARATO («Scarica offline»): se la voce che vale la consente e
 * perché. licence_default = licenza propria o Creative Commons senza "offline"; opt_in =
 * "offline": true; opt_out = "offline": false (scritto, o messo da un doppione: vedi `offBy`);
 * licence_needs_opt_in = licenza "licenza" senza "offline": true.
 */
export const FeaturedRightsOfflineSchema = z
  .object({
    allowed: z.boolean(),
    basis: z.enum(['licence_default', 'opt_in', 'opt_out', 'licence_needs_opt_in']),
    /**
     * Copia spenta perché le voci dello stesso file non sono d'accordo: posizione (da 1) della voce
     * che non la consente. null negli altri casi.
     */
    offBy: z.number().int().positive().nullable(),
  })
  .strict();

export const FeaturedRightsTrackSchema = z
  .object({
    /** Pathname esatto del file audio nello store (quello da scrivere in "file"). */
    pathname: z.string().min(1).max(1024),
    /** Cartella ('' = radice) e titolo della sezione in Home. */
    folder: z.string().max(1024),
    section: z.string().min(1).max(400),
    /** Titolo e artista letti dal nome del file, come in Home. */
    title: z.string().min(1).max(400),
    artist: z.string().max(400).nullable(),
    /** true = una voce valida di diritti.json copre questo file: il brano è ricercabile. */
    declared: z.boolean(),
    /** Dalla voce che vale (null se non dichiarato). */
    licenza: z.string().max(40).nullable(),
    titolare: z.string().max(120).nullable(),
    /** true = dichiarato con "testo": true (in tutte le sue voci). */
    testo: z.boolean(),
    /**
     * Testo spento perché le voci dello stesso file non sono d'accordo: posizione (da 1) della
     * voce senza "testo": true che lo spegne. null negli altri casi.
     */
    testoOffBy: z.number().int().positive().nullable(),
    /** File di testo con lo stesso nome accanto al brano. */
    sidecars: z.object({ lrc: z.boolean(), txt: z.boolean() }).strict(),
    lyrics: FeaturedRightsLyricsSchema,
    /**
     * Trascrizione IA del testo: presente SOLO per i brani dichiarati con "testo": true (per gli
     * altri la funzione non esiste). ready = formato accettato da Whisper; unsupported_format =
     * dichiarato ma in un formato che Whisper non accetta (es. .opus, .aac); too_large = file
     * oltre 25 MB secondo l'elenco dello store (limite di OpenAI).
     */
    transcription: z.enum(['ready', 'unsupported_format', 'too_large']).optional(),
    /** Copia offline: presente SOLO per i brani dichiarati (gli altri non si scaricano mai). */
    offline: FeaturedRightsOfflineSchema.optional(),
  })
  .strict();

export const AdminFeaturedRightsSchema = z
  .object({
    /** Istante della risposta (ISO 8601, UTC). */
    generatedAt: z.string().datetime(),
    store: z
      .object({
        /** ok = elencato tutto; partial = elenco interrotto; unavailable = non configurato/leggibile. */
        status: z.enum(['ok', 'partial', 'unavailable']),
        /** Quando lo store è stato elencato (l'elenco resta in cache ~1 minuto). */
        listedAt: z.string().datetime().nullable(),
        reason: ReasonSchema.nullable(),
      })
      .strict(),
    manifest: FeaturedRightsManifestSchema,
    summary: z
      .object({
        totalTracks: CountSchema,
        declared: CountSchema,
        declaredWithLyrics: CountSchema,
        lyricsFound: CountSchema,
        lyricsMissing: CountSchema,
        lyricsErrors: CountSchema,
        /** Brani con "testo": true non controllati in questa richiesta (tetto o tempo). */
        lyricsSkipped: CountSchema,
        /**
         * Brani con "testo": true oltre i FEATURED_RIGHTS_MAX_TRACKS mostrati (i meno recenti): non
         * compaiono nell'elenco e il loro testo qui non si controlla.
         */
        lyricsNotShown: CountSchema,
        /** Voci di diritti.json scartate o ignorate. */
        manifestProblems: CountSchema,
        /** Brani dichiarati con la copia offline consentita (anche oltre quelli mostrati). */
        offlineAllowed: CountSchema.optional(),
      })
      .strict(),
    tracks: z.array(FeaturedRightsTrackSchema).max(FEATURED_RIGHTS_MAX_TRACKS),
    /** true = lo store ha più brani di quanti ne mostra la risposta. */
    tracksTruncated: z.boolean(),
    /**
     * true = la trascrizione IA dei testi si può usare (OPENAI_API_KEY e store configurati).
     * Assente = false.
     */
    transcriptionAvailable: z.boolean().optional(),
  })
  .strict();

export type FeaturedRightsManifestStatus = z.infer<typeof FeaturedRightsManifestStatusSchema>;
export type FeaturedRightsProblem = z.infer<typeof FeaturedRightsProblemSchema>;
export type FeaturedRightsManifest = z.infer<typeof FeaturedRightsManifestSchema>;
export type FeaturedRightsLyrics = z.infer<typeof FeaturedRightsLyricsSchema>;
export type FeaturedRightsTrack = z.infer<typeof FeaturedRightsTrackSchema>;
export type FeaturedRightsTranscription = NonNullable<FeaturedRightsTrack['transcription']>;
export type FeaturedRightsOffline = z.infer<typeof FeaturedRightsOfflineSchema>;
export type AdminFeaturedRights = z.infer<typeof AdminFeaturedRightsSchema>;

/**
 * POST /api/admin/featured-rights/refresh («Aggiorna ora»): il nuovo valore del contatore condiviso
 * e la versione del catalogo vista subito dopo da questa istanza. `stale` = lo store non ha risposto
 * all'elenco: resta l'ultimo elenco buono e le istanze riprovano da sole.
 */
export const AdminFeaturedRefreshResponseSchema = z
  .object({
    generation: CountSchema,
    version: z.string().regex(/^[0-9a-f]{16}$/),
    updatedAt: z.string().datetime(),
    stale: z.boolean(),
  })
  .strict();
export type AdminFeaturedRefreshResponse = z.infer<typeof AdminFeaturedRefreshResponseSchema>;
