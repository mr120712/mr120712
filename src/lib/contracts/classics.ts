// @polsia:user-owned — contratto di "Classici per decennio": playlist curate dal catalogo lecito.
import { z } from 'zod';
import { AudiusTrackSearchSchema } from '@/lib/contracts/music';

export const ClassicsPlaylistSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  description: z.string().max(240),
  tracks: z.array(AudiusTrackSearchSchema),
});
export type ClassicsPlaylist = z.infer<typeof ClassicsPlaylistSchema>;

export const ClassicsResponseSchema = z.object({
  outcome: z.enum(['results', 'no_results', 'unavailable', 'inactive']),
  /** Slug del decennio selezionato. */
  decade: z.string(),
  label: z.string(),
  tagline: z.string(),
  playlists: z.array(ClassicsPlaylistSchema),
});
export type ClassicsResponse = z.infer<typeof ClassicsResponseSchema>;
