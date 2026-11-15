// @polsia:user-owned — contratto di «Crea playlist» (/crea-playlist): proposte (POST
// /api/music/playlist-engine/suggest), salvataggio in un colpo solo (POST .../save) e stato (GET).
// I brani della bozza hanno la stessa forma degli elementi di una raccolta, così l'anteprima usa
// la stessa conversione verso il player della Libreria. Due sole sorgenti: "audius" (si ascolta
// subito, solo Open Music License) e "song" (artista + titolo, cercato su YouTube SOLO quando lo si
// ascolta, come l'importazione di un elenco). Nessun brano in evidenza, nessuna altra sorgente.
import { z } from 'zod';
import { AudiusTrackFieldsSchema, PlaylistDescriptionInputSchema } from '@/lib/contracts/music';
import { AUDIUS_GENRES, MOOD_IDS } from '@/lib/music/moods';
import { PLAYLIST_DESCRIPTION_MAX_LENGTH } from '@/lib/music/playlist-share';

export const PLAYLIST_ENGINE_PROMPT_MIN = 3;
export const PLAYLIST_ENGINE_PROMPT_MAX = 200;
/** Lunghezze proposte dalla pagina (brani della prima bozza). */
export const PLAYLIST_ENGINE_COUNTS = [10, 20, 30] as const;
/** Il massimo di brani chiesti in una proposta (anche per «Sostituisci» e «Aggiungi altri»). */
export const PLAYLIST_ENGINE_REQUEST_MAX = 30;
/** Il massimo di brani in una bozza e in un salvataggio (ben sotto i 500 di una raccolta). */
export const PLAYLIST_ENGINE_MAX_TRACKS = 50;
/** Brani di scorta per «Sostituisci» e «Aggiungi altri simili» senza una nuova richiesta. */
export const PLAYLIST_ENGINE_RESERVE_MAX = 40;
/** Brani già nella bozza da non riproporre, inviati con una nuova richiesta. */
export const PLAYLIST_ENGINE_EXCLUDE_MAX = 80;
export const PLAYLIST_ENGINE_NAME_MAX = 50;
/** Quanti brani aggiunge «Aggiungi altri simili». */
export const PLAYLIST_ENGINE_ADD_STEP = 5;
export const PLAYLIST_ENGINE_TEXT_MAX = 200;

export const PLAYLIST_ENGINE_EXAMPLES = [
  'Canzoni allegre per una cena d’estate',
  'Cantautori italiani per un viaggio in macchina',
  'Musica tranquilla per lavorare la domenica mattina',
  'Pop anni 80 da ballare in cucina',
] as const;

const songId = z.string().regex(/^[a-f0-9]{32}$/);
const audiusTrackId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fieldText = z.string().min(1).max(PLAYLIST_ENGINE_TEXT_MAX);

/** Un brano "song": solo artista e titolo, cercato su YouTube quando lo si ascolta. */
export const DraftSongTrackSchema = z.object({
  source: z.literal('song'),
  sourceId: songId,
  title: fieldText,
  creatorName: fieldText.nullable(),
  artworkUrl: z.null(),
  sourceUrl: z.null(),
  artistUrl: z.null(),
  durationSeconds: z.null(),
});

/**
 * Un brano Audius riproducibile (Open Music License). `token` è la firma del server sui metadati:
 * al salvataggio il server li accetta solo se la firma corrisponde, senza rileggere Audius.
 */
export const DraftAudiusTrackSchema = z.object({
  source: z.literal('audius'),
  sourceId: audiusTrackId,
  title: fieldText,
  creatorName: fieldText,
  artworkUrl: AudiusTrackFieldsSchema.shape.artworkUrl,
  sourceUrl: AudiusTrackFieldsSchema.shape.trackUrl,
  artistUrl: AudiusTrackFieldsSchema.shape.artistUrl,
  durationSeconds: z.number().int().nonnegative().max(86_400).nullable(),
  token: z.string().min(1).max(200),
});

export const DraftTrackSchema = z.discriminatedUnion('source', [
  DraftSongTrackSchema,
  DraftAudiusTrackSchema,
]);
export type DraftTrack = z.infer<typeof DraftTrackSchema>;

export const PlaylistEngineMoodSchema = z.enum(MOOD_IDS);
export const PlaylistEngineGenreSchema = z.enum(AUDIUS_GENRES);

/** Brano già in bozza: id per escluderlo dal catalogo, titolo e artista per dirlo all'AI. */
export const ExcludedTrackSchema = z.object({
  source: z.enum(['song', 'audius']),
  sourceId: z.string().min(1).max(128),
  title: z.string().max(PLAYLIST_ENGINE_TEXT_MAX),
  artist: z.string().max(PLAYLIST_ENGINE_TEXT_MAX).nullable(),
});
export type ExcludedTrack = z.infer<typeof ExcludedTrackSchema>;

const count = z.number().int().min(1).max(PLAYLIST_ENGINE_REQUEST_MAX);
const exclude = z.array(ExcludedTrackSchema).max(PLAYLIST_ENGINE_EXCLUDE_MAX).default([]);

export const DescribeRequestSchema = z.object({
  mode: z.literal('describe'),
  prompt: z
    .string()
    .trim()
    .min(PLAYLIST_ENGINE_PROMPT_MIN, 'Descrivi la playlist (almeno 3 caratteri).')
    .max(PLAYLIST_ENGINE_PROMPT_MAX, `Massimo ${PLAYLIST_ENGINE_PROMPT_MAX} caratteri.`),
});

/** Il brano o l'artista di partenza; `audius` quando è stato scelto dai risultati Audius. */
export const SeedSchema = z.object({
  artist: z
    .string()
    .trim()
    .min(1, 'Scrivi un artista o un brano.')
    .max(100, 'Massimo 100 caratteri per l’artista.'),
  title: z.string().trim().max(150, 'Massimo 150 caratteri per il brano.').nullable().default(null),
  audius: z
    .object({
      trackId: audiusTrackId,
      genre: z.string().max(60).nullable().default(null),
      mood: z.string().max(60).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type PlaylistSeed = z.infer<typeof SeedSchema>;

export const SeedRequestSchema = z.object({
  mode: z.literal('seed'),
  seed: SeedSchema,
  useAi: z.boolean().default(false),
});

export const MoodRequestSchema = z.object({
  mode: z.literal('mood'),
  mood: PlaylistEngineMoodSchema.nullable().default(null),
  genre: PlaylistEngineGenreSchema.nullable().default(null),
  useAi: z.boolean().default(false),
});

export const MOOD_OR_GENRE_REQUIRED = 'Scegli un’atmosfera o un genere.';

/** Un'atmosfera senza mood né genere non dice niente: l'errore torna sul campo del mood. */
function requireMoodOrGenre(
  value: { mode: string; mood?: string | null; genre?: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.mode === 'mood' && !value.mood && !value.genre) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mood'], message: MOOD_OR_GENRE_REQUIRED });
  }
}

/** La richiesta che ha creato la bozza (senza quantità né esclusioni): riusata per chiederne altri. */
export const EngineOriginSchema = z
  .discriminatedUnion('mode', [DescribeRequestSchema, SeedRequestSchema, MoodRequestSchema])
  .superRefine(requireMoodOrGenre);
export type EngineOrigin = z.infer<typeof EngineOriginSchema>;
export type EngineOriginInput = z.input<typeof EngineOriginSchema>;

export const SuggestRequestSchema = z
  .discriminatedUnion('mode', [
    DescribeRequestSchema.extend({ count, exclude }),
    SeedRequestSchema.extend({ count, exclude }),
    MoodRequestSchema.extend({ count, exclude }),
  ])
  .superRefine(requireMoodOrGenre);
export type SuggestRequest = z.infer<typeof SuggestRequestSchema>;
export type SuggestRequestInput = z.input<typeof SuggestRequestSchema>;

/** Esito della parte AI di una proposta (le parti Audius rispondono comunque). */
export const EngineAiStatusSchema = z.enum([
  'used',
  'not_requested',
  'unavailable',
  'premium_required',
  'rate_limited',
  'refused',
  'busy',
  'failed',
]);
export type EngineAiStatus = z.infer<typeof EngineAiStatusSchema>;

export const SuggestResponseSchema = z.object({
  name: z.string().min(1).max(PLAYLIST_ENGINE_NAME_MAX),
  description: z.string().max(PLAYLIST_DESCRIPTION_MAX_LENGTH).nullable(),
  tracks: z.array(DraftTrackSchema).max(PLAYLIST_ENGINE_REQUEST_MAX),
  reserve: z.array(DraftTrackSchema).max(PLAYLIST_ENGINE_RESERVE_MAX),
  ai: z.object({ status: EngineAiStatusSchema, message: z.string().max(400).nullable() }),
  /** Una spiegazione per una proposta vuota o parziale (fonte non raggiungibile, nessun brano). */
  notice: z.string().max(400).nullable(),
});
export type SuggestResponse = z.infer<typeof SuggestResponseSchema>;

export const PlaylistEngineStatusSchema = z.object({
  signedIn: z.boolean(),
  premium: z.boolean(),
  /** La chiave Anthropic funziona (come per «Cerca con l'AI»). */
  ai: z.boolean(),
  /** Il catalogo Audius è configurato. */
  audius: z.boolean(),
});
export type PlaylistEngineStatus = z.infer<typeof PlaylistEngineStatusSchema>;

export const PLAYLIST_ENGINE_NAME_REQUIRED = 'Dai un nome alla playlist.';
export const PLAYLIST_ENGINE_NAME_TOO_LONG = `Il nome può avere al massimo ${PLAYLIST_ENGINE_NAME_MAX} caratteri.`;

export const SaveRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, PLAYLIST_ENGINE_NAME_REQUIRED)
    .max(PLAYLIST_ENGINE_NAME_MAX, PLAYLIST_ENGINE_NAME_TOO_LONG),
  description: PlaylistDescriptionInputSchema.optional().default(null),
  tracks: z
    .array(DraftTrackSchema)
    .min(1, 'La bozza è vuota: aggiungi almeno un brano.')
    .max(
      PLAYLIST_ENGINE_MAX_TRACKS,
      `Al massimo ${PLAYLIST_ENGINE_MAX_TRACKS} brani per playlist.`,
    ),
});
export type SaveRequestInput = z.input<typeof SaveRequestSchema>;

export const SaveResponseSchema = z.object({
  collectionId: z.string().min(1),
  name: z.string().min(1),
  saved: z.number().int().nonnegative(),
  /** Brani scartati: doppioni o brani Audius con una firma non più valida. */
  skipped: z.number().int().nonnegative(),
});
export type SaveResponse = z.infer<typeof SaveResponseSchema>;

/** La bozza salvata nel sessionStorage: un ricaricamento della pagina non la perde. */
export const StoredDraftSchema = z.object({
  version: z.literal(1),
  origin: EngineOriginSchema,
  name: z.string().max(PLAYLIST_ENGINE_NAME_MAX * 2),
  description: z.string().max(PLAYLIST_DESCRIPTION_MAX_LENGTH * 2),
  tracks: z.array(DraftTrackSchema).max(PLAYLIST_ENGINE_MAX_TRACKS),
  reserve: z.array(DraftTrackSchema).max(PLAYLIST_ENGINE_RESERVE_MAX),
});
export type StoredDraft = z.infer<typeof StoredDraftSchema>;
