// @polsia:user-owned — contratto della ricerca unificata (GET /api/music/search-all): una sola
// query interroga Audius, YouTube (solo all'invio), radio e podcast. La risposta porta UN elenco
// unico ordinato e deduplicato (`results`) PIÙ le sezioni per fonte (`sources`), così il client può
// mostrare la vista mista o quella divisa per fonte. L'avviso YouTube (salvato/limite/resetsAt)
// resta in cima come nella ricerca per fonte.
import { z } from 'zod';
import { PodcastSchema, RadioStationSchema } from '@/lib/contracts/library';
import {
  AudiusAlbumSearchSchema,
  AudiusArtistSearchSchema,
  AudiusPlaylistSearchSchema,
  AudiusTrackSearchSchema,
  YouTubeVideoSearchResultSchema,
} from '@/lib/contracts/music';
import { YouTubeSearchNoticeSchema } from '@/lib/contracts/youtube-search';

/** Tetto all'elenco misto ordinato (le fonti più sopra hanno già i loro limiti). */
export const UNIFIED_RANKED_LIMIT = 40;
/** Brani Audius considerati per l'elenco misto e la sezione (oltre, si tagliano i meno rilevanti). */
export const UNIFIED_AUDIUS_TRACK_LIMIT = 12;
export const UNIFIED_AUDIUS_LIST_LIMIT = 12;
/** Video YouTube: la ricerca ne salva sempre 25 ma all'ascoltatore ne tornano 10. */
export const UNIFIED_YOUTUBE_VIDEO_LIMIT = 10;
export const UNIFIED_RADIO_LIMIT = 8;
export const UNIFIED_PODCAST_LIMIT = 8;

/**
 * Stato indipendente di ogni fonte:
 * - `results`: la fonte ha risposto con almeno un elemento;
 * - `empty`: ha risposto senza nulla da mostrare;
 * - `unavailable`: errore, non configurata o oltre il tempo massimo;
 * - `skipped`: non interrogata (solo YouTube, mentre si digita, prima dell'invio).
 */
export const UnifiedSourceStatusSchema = z.enum(['results', 'empty', 'unavailable', 'skipped']);
export type UnifiedSourceStatus = z.infer<typeof UnifiedSourceStatusSchema>;

/**
 * Una voce dell'elenco misto. `kind` discrimina la fonte riproducibile della voce. La voce Audius
 * può portare `youtubeAlternative`: lo stesso brano trovato anche su YouTube (dedotto per titolo +
 * artista normalizzati), tenuto come azione secondaria invece di comparire due volte nell'elenco.
 * `score` è la rilevanza 0-100 (il client può mostrarla/filtrare); l'ordine finale usa anche la
 * priorità della fonte come spareggio.
 */
export const UnifiedResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('audius'),
    key: z.string().min(1),
    score: z.number(),
    track: AudiusTrackSearchSchema,
    youtubeAlternative: YouTubeVideoSearchResultSchema.nullable(),
  }),
  z.object({
    kind: z.literal('youtube'),
    key: z.string().min(1),
    score: z.number(),
    video: YouTubeVideoSearchResultSchema,
  }),
  z.object({
    kind: z.literal('radio'),
    key: z.string().min(1),
    score: z.number(),
    station: RadioStationSchema,
  }),
  z.object({
    kind: z.literal('podcast'),
    key: z.string().min(1),
    score: z.number(),
    podcast: PodcastSchema,
  }),
]);
export type UnifiedResult = z.infer<typeof UnifiedResultSchema>;

export const UnifiedSearchResponseSchema = z.object({
  query: z.string().min(1),
  /** True quando il chiamante ha inviato il consenso esplicito e YouTube è stato interrogato. */
  youtubeRequested: z.boolean(),
  /** Elenco unico, ordinato per rilevanza e deduplicato fra Audius e YouTube. */
  results: z.array(UnifiedResultSchema),
  /** Le stesse voci divise per fonte, per la vista non mista. */
  sources: z.object({
    audius: z.object({
      status: UnifiedSourceStatusSchema,
      tracks: z.array(AudiusTrackSearchSchema),
      artists: z.array(AudiusArtistSearchSchema),
      playlists: z.array(AudiusPlaylistSearchSchema),
      albums: z.array(AudiusAlbumSearchSchema),
    }),
    youtube: z.object({
      status: UnifiedSourceStatusSchema,
      videos: z.array(YouTubeVideoSearchResultSchema),
    }),
    radio: z.object({
      status: UnifiedSourceStatusSchema,
      stations: z.array(RadioStationSchema),
    }),
    podcasts: z.object({
      status: UnifiedSourceStatusSchema,
      podcasts: z.array(PodcastSchema),
    }),
  }),
  /** Avviso YouTube (in tempo reale o salvato, con il limite che ha bloccato una ricerca nuova). */
  youtube: YouTubeSearchNoticeSchema.optional(),
});
export type UnifiedSearchResponse = z.infer<typeof UnifiedSearchResponseSchema>;
export type UnifiedSearchSources = UnifiedSearchResponse['sources'];
