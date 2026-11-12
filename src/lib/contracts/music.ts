// @polsia:user-owned
import { z } from 'zod';

const audiusId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const safeDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Inserisci una data valida.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Inserisci una data valida.');

const officialAudiusUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'audius.co';
    } catch {
      return false;
    }
  }, 'Il link deve puntare alla pagina ufficiale Audius.');

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Il link deve usare HTTPS.');

export const AudiusTrackFieldsSchema = z.object({
  provider: z.literal('audius'),
  id: audiusId,
  qualifiedId: z.string().regex(/^audius:[A-Za-z0-9_-]{1,128}$/),
  title: z.string().min(1),
  artistName: z.string().min(1),
  artistHandle: z.string().min(1),
  artistId: audiusId,
  artistQualifiedId: z.string().regex(/^audius:[A-Za-z0-9_-]{1,128}$/),
  artistUrl: officialAudiusUrl,
  trackUrl: officialAudiusUrl,
  artworkUrl: httpsUrl,
  durationSeconds: z.number().int().nonnegative().nullable(),
  genre: z.string().nullable(),
  mood: z.string().nullable(),
  tags: z.string().nullable(),
  releaseDate: z.string().nullable(),
  license: z.string().nullable(),
  licensorName: z.string().min(1).nullable(),
  copyrightNotice: z.string().min(1).nullable(),
  producerCopyrightNotice: z.string().min(1).nullable(),
  attributionRemovalRequested: z.boolean(),
  attributionComplete: z.boolean(),
  playbackEligible: z.boolean(),
  playbackReason: z.enum([
    'ready',
    'not_streamable',
    'gated',
    'access_denied',
    'access_unknown',
    'license_not_allowed',
    'rate_limited',
    'state_unknown',
  ]),
});

export const AudiusTrackSearchSchema = AudiusTrackFieldsSchema.refine(
  (track) => track.qualifiedId === `audius:${track.id}`,
  { message: 'L’identificativo qualificato deve appartenere allo stesso brano Audius.' },
);

export const AudiusArtistSearchSchema = z
  .object({
    provider: z.literal('audius'),
    id: audiusId,
    qualifiedId: z.string().regex(/^audius:[A-Za-z0-9_-]{1,128}$/),
    name: z.string().min(1),
    handle: z.string().min(1),
    artworkUrl: httpsUrl,
    profileUrl: officialAudiusUrl,
  })
  .refine((artist) => artist.qualifiedId === `audius:${artist.id}`, {
    message: 'L’identificativo qualificato deve appartenere allo stesso profilo Audius.',
  });

export const AudiusPlaylistSearchSchema = z
  .object({
    provider: z.literal('audius'),
    id: audiusId,
    qualifiedId: z.string().regex(/^audius:playlist:[A-Za-z0-9_-]{1,128}$/),
    title: z.string().min(1),
    artistName: z.string().min(1),
    artistUrl: officialAudiusUrl,
    playlistUrl: officialAudiusUrl,
    artworkUrl: httpsUrl,
    trackCount: z.number().int().nonnegative().nullable(),
  })
  .refine((playlist) => playlist.qualifiedId === `audius:playlist:${playlist.id}`, {
    message: 'L’identificativo qualificato deve appartenere alla stessa playlist Audius.',
  });

export const AudiusAlbumSearchSchema = z
  .object({
    provider: z.literal('audius'),
    id: audiusId,
    qualifiedId: z.string().regex(/^audius:album:[A-Za-z0-9_-]{1,128}$/),
    title: z.string().min(1),
    artistName: z.string().min(1).nullable(),
    artistUrl: officialAudiusUrl.nullable(),
    albumUrl: officialAudiusUrl,
    artworkUrl: httpsUrl.nullable(),
    releaseDate: z.string().nullable(),
    trackCount: z.number().int().nonnegative().nullable(),
  })
  .refine((album) => album.qualifiedId === `audius:album:${album.id}`, {
    message: 'L’identificativo qualificato deve appartenere allo stesso album Audius.',
  });

export const AudiusAlbumTrackSchema = AudiusTrackFieldsSchema.extend({
  albumId: audiusId,
  fullAccess: z.enum(['available', 'pro_required', 'rights_unverified', 'unavailable']),
}).refine((track) => track.qualifiedId === `audius:${track.id}`, {
  message: 'L’identificativo qualificato deve appartenere allo stesso brano Audius.',
});

export const AudiusAlbumDetailSchema = z.object({
  album: AudiusAlbumSearchSchema,
  tracks: z.array(AudiusAlbumTrackSchema),
});
export type AudiusAlbumSearchResult = z.infer<typeof AudiusAlbumSearchSchema>;
export type AudiusAlbumTrack = z.infer<typeof AudiusAlbumTrackSchema>;
export type AudiusAlbumDetail = z.infer<typeof AudiusAlbumDetailSchema>;

export const YouTubeVideoSearchResultSchema = z.object({
  provider: z.literal('youtube'),
  videoId,
  title: z.string().min(1),
  channelTitle: z.string().min(1),
  channelId: z.string().min(1).nullable(),
  description: z.string().nullable(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  thumbnailUrl: httpsUrl.nullable(),
});

export const YouTubeChartResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable']),
  regionCode: z.string().regex(/^[A-Z]{2}$/),
  videos: z.array(
    YouTubeVideoSearchResultSchema.extend({
      durationSeconds: z.number().int().positive().nullable(),
    }),
  ),
});
export type YouTubeChartResponse = z.infer<typeof YouTubeChartResponseSchema>;

export const MusicSearchSourceSchema = z.object({
  id: z.enum(['audius', 'youtube']),
  label: z.string().min(1),
  active: z.boolean(),
  searchOutcome: z.enum(['idle', 'results', 'no_results', 'partial', 'unavailable', 'inactive']),
  unavailableReason: z.enum(['not_configured', 'quota_exceeded', 'api_error']).optional(),
  blockers: z.array(z.enum(['credential_missing'])).optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
  summary: z.string().min(1),
  prerequisite: z.string().min(1),
});

export const MusicSourceStatusListSchema = z.object({
  sources: z.array(MusicSearchSourceSchema).length(2),
});

export const MusicSearchResponseSchema = z.object({
  source: z.enum(['audius', 'youtube']),
  outcome: z.enum(['results', 'no_results', 'partial', 'unavailable', 'inactive']),
  tracks: z.array(AudiusTrackSearchSchema),
  artists: z.array(AudiusArtistSearchSchema),
  playlists: z.array(AudiusPlaylistSearchSchema),
  albums: z.array(AudiusAlbumSearchSchema),
  videos: z.array(YouTubeVideoSearchResultSchema),
  sourceStatus: MusicSearchSourceSchema,
});

export const YouTubeVideoEligibilitySchema = z.object({
  videoId,
  eligibility: z.enum(['playable', 'made_for_kids', 'unknown', 'unavailable']),
  message: z.string().min(1),
  video: YouTubeVideoSearchResultSchema.optional(),
});

export const AudiusPlaybackCheckSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: z.string().min(1) }),
]);

export const MusicTrendingResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'partial', 'unavailable', 'inactive']),
  tracks: z.array(AudiusTrackSearchSchema),
  albums: z.array(AudiusAlbumSearchSchema),
  sourceStatus: MusicSearchSourceSchema,
});
export type MusicTrendingResponse = z.infer<typeof MusicTrendingResponseSchema>;

const AudiusHomeSectionOutcomeSchema = z.enum(['results', 'no_results', 'unavailable']);

export const MusicHomeResponseSchema = z.object({
  sourceStatus: MusicSearchSourceSchema,
  trending: z.object({
    outcome: AudiusHomeSectionOutcomeSchema,
    tracks: z.array(AudiusTrackSearchSchema),
  }),
  releases: z.object({
    outcome: AudiusHomeSectionOutcomeSchema,
    albums: z.array(AudiusAlbumSearchSchema),
  }),
  playlists: z.object({
    outcome: AudiusHomeSectionOutcomeSchema,
    playlists: z.array(AudiusPlaylistSearchSchema),
  }),
  artists: z.object({
    outcome: AudiusHomeSectionOutcomeSchema,
    artists: z.array(AudiusArtistSearchSchema),
  }),
});
export type MusicHomeResponse = z.infer<typeof MusicHomeResponseSchema>;

export const MusicCollectionKindSchema = z.enum(['favorites', 'playlist']);
export const MusicCollectionItemSchema = z.object({
  id: z.string().min(1),
  // 'song': imported from a track list (artist + title), found on YouTube when played.
  source: z.enum(['audius', 'youtube', 'song']),
  sourceId: z.string().min(1),
  title: z.string().min(1).nullable(),
  creatorName: z.string().min(1).nullable(),
  artworkUrl: httpsUrl.nullable(),
  sourceUrl: httpsUrl.nullable(),
  artistUrl: officialAudiusUrl.nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});

export const MusicCollectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: MusicCollectionKindSchema,
  folderId: z.string().min(1).nullable().optional(),
  createdAt: z.string().datetime(),
  items: z.array(MusicCollectionItemSchema),
});

export const MusicCollectionsSchema = z.object({ collections: z.array(MusicCollectionSchema) });

export const CollectionMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_playlist'), name: z.string().trim().min(1).max(50) }),
  z.object({
    action: z.literal('favorite'),
    source: z.enum(['audius', 'youtube']),
    sourceId: z.string().min(1),
  }),
  z.object({
    action: z.literal('add'),
    collectionId: z.string().min(1),
    source: z.enum(['audius', 'youtube']),
    sourceId: z.string().min(1),
  }),
  z.object({
    action: z.literal('remove_item'),
    collectionId: z.string().min(1),
    itemId: z.string().min(1),
  }),
  z.object({ action: z.literal('delete_playlist'), collectionId: z.string().min(1) }),
]);

export const CollectionMutationResponseSchema = z.object({
  collections: z.array(MusicCollectionSchema),
  message: z.string().optional(),
});

export const ListeningEntrySchema = z.object({
  id: z.string(),
  albumId: z.string(),
  catalogProvider: z.string().max(40),
  albumName: z.string().min(1),
  artistName: z.string().min(1),
  artworkUrl: httpsUrl.nullable(),
  releaseDate: z.string().nullable(),
  genre: z.string().nullable(),
  trackCount: z.number().int().nonnegative().nullable(),
  rating: z.number().min(1).max(5).multipleOf(0.5),
  note: z.string().min(1).max(2000),
  listenedOn: safeDate,
  context: z.string().max(80).nullable(),
  createdAt: z.string().datetime(),
});

export const ListeningEntryListSchema = z.object({ entries: z.array(ListeningEntrySchema) });
export const ListeningUsageSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  remaining: z.number().int().nonnegative(),
  month: z.string().min(1),
});
export const ListeningUsageResponseSchema = z.object({ usage: ListeningUsageSchema });

const listeningFields = {
  albumId: z.string().trim().min(1).max(128),
  catalogProvider: z.string().trim().min(1).max(40),
  albumName: z.string().trim().min(1, 'Titolo richiesto.').max(200),
  artistName: z.string().trim().min(1, 'Artista richiesto.').max(160),
  artworkUrl: httpsUrl.nullable(),
  releaseDate: z.string().nullable(),
  genre: z.string().nullable(),
  trackCount: z.number().int().nonnegative().nullable(),
  rating: z.number().min(1).max(5).multipleOf(0.5, 'Il voto cresce di mezza stella.'),
  note: z.string().trim().min(1, 'Aggiungi una nota.').max(2000),
  listenedOn: safeDate,
  context: z.union([z.string().trim().max(80), z.null()]).optional(),
};

export const CreateListeningEntrySchema = z.object(listeningFields);
export const UpdateListeningEntrySchema = z
  .object({
    rating: listeningFields.rating.optional(),
    note: listeningFields.note.optional(),
    listenedOn: listeningFields.listenedOn.optional(),
    context: listeningFields.context,
  })
  .refine((value) => Object.keys(value).length > 0, 'Indica almeno un campo da modificare.');
export const ListeningEntryResponseSchema = z.object({ entry: ListeningEntrySchema });
export const CreatedListeningEntryResponseSchema = z.object({
  entry: ListeningEntrySchema,
  usage: ListeningUsageSchema,
});

export type AudiusTrackSearchResult = z.infer<typeof AudiusTrackSearchSchema>;
export type AudiusArtistSearchResult = z.infer<typeof AudiusArtistSearchSchema>;
export type AudiusPlaylistSearchResult = z.infer<typeof AudiusPlaylistSearchSchema>;
export type YouTubeVideoSearchResult = z.infer<typeof YouTubeVideoSearchResultSchema>;
export type MusicSearchSource = z.infer<typeof MusicSearchSourceSchema>;
export type MusicSearchResponse = z.infer<typeof MusicSearchResponseSchema>;
export type MusicCollectionItem = z.infer<typeof MusicCollectionItemSchema>;
export type MusicCollection = z.infer<typeof MusicCollectionSchema>;
export type MusicCollections = z.infer<typeof MusicCollectionsSchema>;
export type YouTubeVideoEligibility = z.infer<typeof YouTubeVideoEligibilitySchema>;
export type ListeningEntry = z.infer<typeof ListeningEntrySchema>;
export type ListeningUsage = z.infer<typeof ListeningUsageSchema>;
export type CreateListeningEntry = z.infer<typeof CreateListeningEntrySchema>;
export type UpdateListeningEntry = z.infer<typeof UpdateListeningEntrySchema>;
