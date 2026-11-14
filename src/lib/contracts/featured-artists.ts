// @polsia:user-owned — contratto condiviso (client + route handler) della pagina d'artista dei
// "brani in evidenza" (GET /api/music/featured/artists/<slug>, pagina /artista/<slug>). Elenca SOLO
// i brani con i diritti dichiarati in diritti.json (mai l'elenco grezzo della Home), con gli stessi
// dati della Home (copertina, streamUrl), così la riproduzione è identica.
import { z } from 'zod';
import { FeaturedArtistSlugSchema, HomeTrackResultSchema } from '@/lib/contracts/home-tracks';

export { FeaturedArtistSlugSchema };

/** Tetto ai brani di una pagina d'artista (dal più recente). */
export const FEATURED_ARTIST_TRACK_LIMIT = 200;

export const FeaturedArtistSchema = z.object({
  /** La grafia più frequente del nome fra i brani dell'artista. */
  name: z.string().min(1).max(200),
  slug: FeaturedArtistSlugSchema,
});
export type FeaturedArtist = z.infer<typeof FeaturedArtistSchema>;

export const FeaturedArtistResponseSchema = z.object({
  artist: FeaturedArtistSchema,
  /** I brani dichiarati dell'artista (principale o ospite), dal più recente. */
  tracks: z.array(HomeTrackResultSchema).max(FEATURED_ARTIST_TRACK_LIMIT),
});
export type FeaturedArtistResponse = z.infer<typeof FeaturedArtistResponseSchema>;

/** Percorso dell'API della pagina d'artista. */
export function featuredArtistApiPath(slug: string): string {
  return `/api/music/featured/artists/${encodeURIComponent(slug)}`;
}
