// @polsia:user-owned — contratto condiviso (client + route handler) del link diretto di un brano in
// evidenza (GET /api/music/featured/tracks/<shareId>, pagina /evidenza/<shareId>). Esiste SOLO per i
// brani con i diritti dichiarati in diritti.json. Senza sessione arrivano solo i metadati (titolo,
// artista, link all'artista, copertina per id): mai lo stream né il pathname del file nello store.
// Con una sessione arriva anche il brano della Home (`homeTrack`, con streamUrl) da riprodurre.
import { z } from 'zod';
import {
  FeaturedArtistSlugSchema,
  FeaturedShareIdSchema,
  HomeTrackResultSchema,
} from '@/lib/contracts/home-tracks';
import { isFeaturedShareCoverPath } from '@/lib/music/featured-share';

export { FeaturedShareIdSchema };

/** I metadati pubblici del brano condiviso (uguali per chiunque apra il link). */
export const FeaturedShareTrackSchema = z.object({
  shareId: FeaturedShareIdSchema,
  title: z.string().min(1).max(200),
  artist: z.string().min(1).max(200).nullable(),
  /** Pagina dell'artista principale (/artista/<slug>); null = nessun link. */
  artistSlug: FeaturedArtistSlugSchema.nullable(),
  /** Copertina servita per id (/api/music/featured/tracks/<id>/cover); null = nessuna copertina. */
  coverPath: z
    .string()
    .max(200)
    .refine(isFeaturedShareCoverPath, { message: 'Copertina non valida.' })
    .nullable(),
});
export type FeaturedShareTrack = z.infer<typeof FeaturedShareTrackSchema>;

export const FeaturedShareResponseSchema = z.object({
  track: FeaturedShareTrackSchema,
  /** Il brano da riprodurre (stesso della Home): SOLO con una sessione, altrimenti null. */
  homeTrack: HomeTrackResultSchema.nullable(),
});
export type FeaturedShareResponse = z.infer<typeof FeaturedShareResponseSchema>;
