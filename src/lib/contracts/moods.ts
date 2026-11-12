// @polsia:user-owned — contratto condiviso del feed per mood della Home (GET /api/music/moods/[mood]).
// Ogni sezione ha il proprio stato: una fonte che non risponde non svuota le altre.
import { z } from 'zod';
import { PodcastSchema, RadioStationSchema } from '@/lib/contracts/library';
import { AudiusTrackFieldsSchema } from '@/lib/contracts/music';
import { MOOD_IDS } from '@/lib/music/moods';

export const MOOD_TRACK_LIMIT = 20;
export const MOOD_STATION_LIMIT = 8;
export const MOOD_PODCAST_LIMIT = 8;
export const MOOD_GENRE_LIMIT = 6;

export const MoodIdSchema = z.enum(MOOD_IDS);

/** Solo i campi che servono alla riga brano Audius (riproduzione, attribuzione, licenza OML). */
export const MoodTrackSchema = AudiusTrackFieldsSchema.pick({
  id: true,
  qualifiedId: true,
  title: true,
  artistName: true,
  artistUrl: true,
  trackUrl: true,
  artworkUrl: true,
  durationSeconds: true,
  license: true,
  licensorName: true,
  copyrightNotice: true,
  attributionRemovalRequested: true,
  playbackEligible: true,
  playbackReason: true,
}).refine((track) => track.qualifiedId === `audius:${track.id}`, {
  message: 'L’identificativo qualificato deve appartenere allo stesso brano Audius.',
});
export type MoodTrack = z.infer<typeof MoodTrackSchema>;

export const MoodGenreLinkSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  name: z.string().min(1).max(80),
  href: z.string().regex(/^\/generi\/[a-z0-9-]{1,60}$/),
});
export type MoodGenreLink = z.infer<typeof MoodGenreLinkSchema>;

/** `results` anche con zero elementi (fonte raggiunta, niente da mostrare); `unavailable` = errore. */
export const MoodSectionStatusSchema = z.enum(['results', 'unavailable']);
export type MoodSectionStatus = z.infer<typeof MoodSectionStatusSchema>;

const section = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.object({ status: MoodSectionStatusSchema, items: z.array(item).max(max) });

export const MoodFeedResponseSchema = z.object({
  mood: z.object({
    id: MoodIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
  }),
  tracks: section(MoodTrackSchema, MOOD_TRACK_LIMIT),
  stations: section(RadioStationSchema, MOOD_STATION_LIMIT),
  podcasts: section(PodcastSchema, MOOD_PODCAST_LIMIT),
  genres: section(MoodGenreLinkSchema, MOOD_GENRE_LIMIT),
});
export type MoodFeedResponse = z.infer<typeof MoodFeedResponseSchema>;
