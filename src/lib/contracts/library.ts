// @polsia:user-owned — contratti condivisi per radio, podcast e Libreria in stile app.
import { z } from 'zod';

const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const podcastId = z.string().regex(/^[0-9]{1,20}$/);
const episodeKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Il link deve usare HTTPS.');

const shortText = (max: number) => z.string().trim().min(1).max(max);

// ---------- Radio ----------
export const RadioStationSchema = z.object({
  id: safeId,
  name: shortText(200),
  artworkUrl: httpsUrl.nullable(),
  country: z.string().max(100).nullable(),
  countryCode: z.string().max(4).nullable(),
  tags: z.array(z.string().max(60)).max(12),
  codec: z.string().max(20).nullable(),
  bitrate: z.number().int().nonnegative().nullable(),
  homepage: httpsUrl.nullable(),
  votes: z.number().int().nonnegative(),
});
export type RadioStation = z.infer<typeof RadioStationSchema>;

export const RadioListResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable']),
  stations: z.array(RadioStationSchema),
});
export type RadioListResponse = z.infer<typeof RadioListResponseSchema>;

export const RadioListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  tag: z.string().trim().max(40).optional(),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(60).default(30),
});

// ---------- Podcast ----------
export const PodcastSchema = z.object({
  id: podcastId,
  title: shortText(300),
  author: z.string().max(300).nullable(),
  artworkUrl: httpsUrl.nullable(),
  genre: z.string().max(100).nullable(),
});
export type Podcast = z.infer<typeof PodcastSchema>;

export const PodcastListResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable']),
  podcasts: z.array(PodcastSchema),
});
export type PodcastListResponse = z.infer<typeof PodcastListResponseSchema>;

export const PodcastEpisodeSchema = z.object({
  key: episodeKey,
  title: shortText(400),
  publishedAt: z.string().datetime().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  description: z.string().max(600).nullable(),
  artworkUrl: httpsUrl.nullable(),
  /** L'episodio ha un trascritto (tag podcast:transcript nel feed). */
  hasTranscript: z.boolean(),
});
export type PodcastEpisode = z.infer<typeof PodcastEpisodeSchema>;

export const TranscriptCueSchema = z.object({
  /** Secondi di inizio del segmento (null se il formato non è temporizzato). */
  startSeconds: z.number().nonnegative().nullable(),
  text: z.string().min(1).max(2000),
});
export const PodcastTranscriptResponseSchema = z.object({
  available: z.boolean(),
  /** true se almeno un cue ha un tempo: si può sincronizzare e saltare a un punto. */
  timed: z.boolean(),
  cues: z.array(TranscriptCueSchema),
});
export type PodcastTranscriptResponse = z.infer<typeof PodcastTranscriptResponseSchema>;

export const PodcastDetailResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable']),
  podcast: PodcastSchema.nullable(),
  episodes: z.array(PodcastEpisodeSchema),
});
export type PodcastDetailResponse = z.infer<typeof PodcastDetailResponseSchema>;

// ---------- Jamendo (Premium) ----------
export const JamendoTrackSchema = z.object({
  id: z.string().regex(/^[0-9]{1,20}$/),
  title: shortText(300),
  artistName: shortText(300),
  albumName: z.string().max(300).nullable(),
  artworkUrl: httpsUrl.nullable(),
  durationSeconds: z.number().int().positive().nullable(),
  pageUrl: httpsUrl.nullable(),
  licenseUrl: httpsUrl.nullable(),
});
export type JamendoTrack = z.infer<typeof JamendoTrackSchema>;

export const JamendoListResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable', 'not_configured']),
  tracks: z.array(JamendoTrackSchema),
});
export type JamendoListResponse = z.infer<typeof JamendoListResponseSchema>;

// ---------- Libreria ----------
export const PlaybackModeSchema = z.enum([
  'audius',
  'solco',
  'radio',
  'podcast',
  'jamendo',
  'youtube',
  'recording',
]);

export const HistoryTrackSchema = z.object({
  qualifiedId: z
    .string()
    .regex(
      /^(audius:[A-Za-z0-9_-]{1,128}|radio:[A-Za-z0-9_-]{1,128}|podcast:[0-9]{1,20}~[A-Za-z0-9_-]{1,64}|jamendo:[0-9]{1,20}|youtube:[A-Za-z0-9_-]{11}|recording:[a-z0-9]{20,36})$/,
    ),
  title: shortText(400),
  artistName: shortText(300),
  artworkUrl: httpsUrl.nullable(),
  sourceLabel: shortText(80),
  sourceUrl: httpsUrl.nullable(),
  albumId: safeId.nullable(),
  durationSeconds: z.number().int().nonnegative().max(86_400).nullable(),
  playbackMode: PlaybackModeSchema,
});
export type HistoryTrack = z.infer<typeof HistoryTrackSchema>;

export const HistoryEntrySchema = HistoryTrackSchema.extend({
  playCount: z.number().int().positive(),
  lastPlayedAt: z.string().datetime(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const SavedStationSchema = z.object({
  stationId: safeId,
  name: shortText(200),
  artworkUrl: httpsUrl.nullable(),
  country: z.string().max(100).nullable(),
  tags: z.string().max(400).nullable(),
  homepage: httpsUrl.nullable(),
});
export type SavedStation = z.infer<typeof SavedStationSchema>;

export const FollowedPodcastSchema = z.object({
  podcastId,
  title: shortText(300),
  author: z.string().max(300).nullable(),
  artworkUrl: httpsUrl.nullable(),
});
export type FollowedPodcast = z.infer<typeof FollowedPodcastSchema>;

export const MusicFolderSchema = z.object({
  id: z.string().min(1),
  name: shortText(50),
  playlistIds: z.array(z.string().min(1)),
});
export type MusicFolder = z.infer<typeof MusicFolderSchema>;

export const HiddenKindSchema = z.enum(['artist', 'station', 'podcast']);
export const HiddenItemSchema = z.object({
  kind: HiddenKindSchema,
  itemId: shortText(200),
  label: z.string().max(200).nullable(),
});
export type HiddenItem = z.infer<typeof HiddenItemSchema>;

export const LibraryResponseSchema = z.object({
  stations: z.array(SavedStationSchema),
  podcasts: z.array(FollowedPodcastSchema),
  folders: z.array(MusicFolderSchema),
  history: z.array(HistoryEntrySchema),
  hidden: z.array(HiddenItemSchema),
});
export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;

export const LibraryMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record_play'), track: HistoryTrackSchema }),
  z.object({ action: z.literal('clear_history') }),
  z.object({ action: z.literal('save_station'), station: SavedStationSchema }),
  z.object({ action: z.literal('unsave_station'), stationId: safeId }),
  z.object({ action: z.literal('follow_podcast'), podcast: FollowedPodcastSchema }),
  z.object({ action: z.literal('unfollow_podcast'), podcastId }),
  z.object({ action: z.literal('create_folder'), name: shortText(50) }),
  z.object({
    action: z.literal('rename_folder'),
    folderId: z.string().min(1),
    name: shortText(50),
  }),
  z.object({ action: z.literal('delete_folder'), folderId: z.string().min(1) }),
  z.object({
    action: z.literal('move_playlist'),
    collectionId: z.string().min(1),
    folderId: z.string().min(1).nullable(),
  }),
  z.object({ action: z.literal('hide'), item: HiddenItemSchema }),
  z.object({ action: z.literal('unhide'), kind: HiddenKindSchema, itemId: shortText(200) }),
]);
export type LibraryMutation = z.infer<typeof LibraryMutationSchema>;

export const LibraryMutationResponseSchema = z.object({
  ok: z.literal(true),
  library: LibraryResponseSchema.optional(),
});

// ---------- Import playlist YouTube ----------
export const YouTubePlaylistImportSchema = z.object({
  url: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(50).optional(),
});

export const YouTubePlaylistImportResponseSchema = z.object({
  collectionId: z.string().min(1),
  name: z.string().min(1),
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type YouTubePlaylistImportResponse = z.infer<typeof YouTubePlaylistImportResponseSchema>;

/** Elenco di brani portato dall'utente (righe "Artista - Titolo" o un CSV esportato). */
export const TrackListImportSchema = z.object({
  text: z.string().min(1).max(300_000),
  name: z.string().trim().min(1).max(50).optional(),
});

export const TrackListImportResponseSchema = YouTubePlaylistImportResponseSchema.extend({
  format: z.enum(['csv', 'lines']),
  /** Brani validi oltre il limite di 200 per elenco. */
  truncated: z.number().int().nonnegative().default(0),
});

/** Video YouTube trovato per un brano importato; null se non trovato. */
export const SongResolveResponseSchema = z.object({
  video: z
    .object({
      videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
      title: z.string().min(1),
      channelTitle: z.string().min(1),
      thumbnailUrl: z.string().url().nullable(),
    })
    .nullable(),
});
export type SongResolveResponse = z.infer<typeof SongResolveResponseSchema>;

// ---------- TikTok (video scelti dall'amministratore) ----------
export const TikTokClipSchema = z.object({
  id: z.string().min(1),
  videoId: z.string().regex(/^\d{8,25}$/),
  handle: z.string().regex(/^[A-Za-z0-9._]{2,24}$/),
  canonicalUrl: z.string().url(),
  soundUrl: z.string().url().nullable(),
  caption: z.string().max(200).nullable(),
  genreSlug: z.string().max(80).nullable(),
});
export type TikTokClip = z.infer<typeof TikTokClipSchema>;
export const TikTokClipListSchema = z.object({ clips: z.array(TikTokClipSchema) });

export const TikTokClipCreateSchema = z.object({
  url: z.string().trim().min(1).max(500),
  soundUrl: z.string().trim().max(500).optional(),
  caption: z.string().trim().max(200).optional(),
  genreSlug: z.string().trim().max(80).optional(),
});
