// @polsia:user-owned — contratto condiviso (client + route handler) della pagina «Mostra tutti» di
// una sezione dei "brani in evidenza" (GET /api/music/featured/sections/<id>, pagina
// /cartella/<id>). Elenca SOLO i brani della cartella con i diritti dichiarati in diritti.json (mai
// l'elenco grezzo della Home), con gli stessi dati della Home (copertina, streamUrl), così la
// riproduzione è identica. Premium vede tutti i brani dichiarati, Free i 30 più recenti con il totale
// (`total`) per «30 di N brani» (featured-plan).
import { z } from 'zod';
import { FeaturedSectionIdSchema, HomeTrackResultSchema } from '@/lib/contracts/home-tracks';
import {
  FEATURED_SECTION_TRACK_LIMIT,
  featuredSectionApiPath,
} from '@/lib/music/featured-sections';

export { FEATURED_SECTION_TRACK_LIMIT, FeaturedSectionIdSchema, featuredSectionApiPath };

export const FeaturedSectionSchema = z.object({
  id: FeaturedSectionIdSchema,
  /** Il titolo della sezione, con le stesse regole della Home. */
  title: z.string().min(1).max(200),
  /**
   * true per la radice dello store: in Home la sua intestazione è «Ascolta ora» sotto «In
   * evidenza», e la pagina mostra la stessa. Assente = sezione normale.
   */
  root: z.boolean().optional(),
  /**
   * true per un genere della fila «Per genere» della Home ("genere" in diritti.json): la pagina elenca
   * i brani dichiarati con quel genere, non una cartella. Assente = cartella dello store.
   */
  genre: z.boolean().optional(),
});
export type FeaturedSection = z.infer<typeof FeaturedSectionSchema>;

export const FeaturedSectionResponseSchema = z
  .object({
    section: FeaturedSectionSchema,
    /**
     * I brani dichiarati della cartella, dal più recente (al massimo FEATURED_SECTION_TRACK_LIMIT); a
     * un account Free solo i 30 più recenti (featured-plan).
     */
    tracks: z.array(HomeTrackResultSchema).max(FEATURED_SECTION_TRACK_LIMIT),
    /**
     * Brani dichiarati della cartella in tutto: più di `tracks` quando un account Free ne vede solo
     * una parte. Assente da un server meno recente: vale come il numero di `tracks`.
     */
    total: z.number().int().nonnegative().optional(),
  })
  .refine((body) => body.total === undefined || body.total >= body.tracks.length, {
    message: 'Il totale non può essere minore dei brani inviati.',
  });
export type FeaturedSectionResponse = z.infer<typeof FeaturedSectionResponseSchema>;
