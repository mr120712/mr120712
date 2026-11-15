// @polsia:user-owned — contratto condiviso (client + route handler) della pagina d'artista dei
// "brani in evidenza" (GET /api/music/featured/artists/<slug>, pagina /artista/<slug>). Elenca SOLO
// i brani con i diritti dichiarati in diritti.json (mai l'elenco grezzo della Home), con gli stessi
// dati della Home (copertina, streamUrl), così la riproduzione è identica. Premium vede tutti i brani
// dichiarati, Free i 30 più recenti con il totale (`total`) per «30 di N brani» (featured-plan).
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

export const FeaturedArtistResponseSchema = z
  .object({
    artist: FeaturedArtistSchema,
    /**
     * I brani dichiarati dell'artista (principale o ospite), dal più recente; a un account Free
     * solo i 30 più recenti (featured-plan).
     */
    tracks: z.array(HomeTrackResultSchema).max(FEATURED_ARTIST_TRACK_LIMIT),
    /**
     * Brani dichiarati dell'artista in tutto: più di `tracks` quando un account Free ne vede solo
     * una parte. Assente da un server meno recente: vale come il numero di `tracks`.
     */
    total: z.number().int().nonnegative().optional(),
  })
  .refine((body) => body.total === undefined || body.total >= body.tracks.length, {
    message: 'Il totale non può essere minore dei brani inviati.',
  });
export type FeaturedArtistResponse = z.infer<typeof FeaturedArtistResponseSchema>;

/** Percorso dell'API della pagina d'artista. */
export function featuredArtistApiPath(slug: string): string {
  return `/api/music/featured/artists/${encodeURIComponent(slug)}`;
}
