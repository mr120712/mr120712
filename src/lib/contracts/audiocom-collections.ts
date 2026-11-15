// @polsia:user-owned — contratti condivisi (client + route) di «In evidenza da audio.com»: le
// collection dell'account audio.com collegato (pagina admin /admin/audiocom) e le sezioni della Home
// con i loro brani. I brani hanno lo stesso contratto della ricerca (AudioComTrackSchema): lo stream
// c'è SOLO con una licenza riproducibile in Solco (CC0, CC BY, CC BY-SA, CC BY-ND) e mai per una
// cover; gli altri si ascoltano nel player ufficiale di audio.com.
import { z } from 'zod';
import { AudioComTrackSchema } from '@/lib/contracts/audiocom';
import { AUDIOCOM_ID_PATTERN, audioComImageUrl } from '@/lib/music/audiocom-license';

/** Quante collection al massimo in Home. */
export const AUDIOCOM_FEATURED_COLLECTIONS_MAX = 6;
/** Quanti brani al massimo per sezione (i primi della collection, nel suo ordine). */
export const AUDIOCOM_COLLECTION_TRACKS_MAX = 50;
/** Quante collection dell'account mostra la pagina admin. */
export const AUDIOCOM_COLLECTIONS_LIST_MAX = 100;

export const AudioComCollectionIdSchema = z.string().regex(AUDIOCOM_ID_PATTERN);

const ImageUrlSchema = z
  .string()
  .nullable()
  .refine((value) => value === null || audioComImageUrl(value) === value, 'Copertina non valida');

/** Una collection dell'account collegato (pagina admin). */
export const AudioComCollectionSummarySchema = z.object({
  id: AudioComCollectionIdSchema,
  title: z.string().min(1).max(300),
  /** Tipo di audio.com (es. "playlist", "album"), vuoto se manca. */
  type: z.string().max(40),
  itemsCount: z.number().int().nonnegative(),
  /** false = non pubblica su audio.com (raggiungibile solo dal link). */
  listed: z.boolean(),
  imageUrl: ImageUrlSchema,
  /** true se è fra quelle mostrate in Home. */
  featured: z.boolean(),
});
export type AudioComCollectionSummary = z.infer<typeof AudioComCollectionSummarySchema>;

/** GET /api/admin/audiocom/collections (e risposta del PUT). */
export const AudioComCollectionsAdminResponseSchema = z.object({
  /** ok: elenco letto; disconnected: nessun account collegato; unavailable: audio.com non risponde. */
  status: z.enum(['ok', 'disconnected', 'unavailable']),
  collections: z.array(AudioComCollectionSummarySchema).max(AUDIOCOM_COLLECTIONS_LIST_MAX),
  /** Le collection in Home, nell'ordine (anche quando l'elenco di audio.com non è disponibile). */
  featuredIds: z.array(AudioComCollectionIdSchema).max(AUDIOCOM_FEATURED_COLLECTIONS_MAX),
});
export type AudioComCollectionsAdminResponse = z.infer<
  typeof AudioComCollectionsAdminResponseSchema
>;

/** PUT /api/admin/audiocom/collections: le collection da mostrare in Home, nell'ordine. */
export const AudioComFeaturedInputSchema = z
  .object({
    collectionIds: z
      .array(AudioComCollectionIdSchema)
      .max(
        AUDIOCOM_FEATURED_COLLECTIONS_MAX,
        `Al massimo ${AUDIOCOM_FEATURED_COLLECTIONS_MAX} collection in Home.`,
      )
      .refine((ids) => new Set(ids).size === ids.length, 'Una collection è ripetuta.'),
  })
  .strict();
export type AudioComFeaturedInput = z.infer<typeof AudioComFeaturedInputSchema>;

/** Una sezione della Home: una collection con i suoi brani musicali (almeno uno). */
export const AudioComHomeSectionSchema = z.object({
  id: AudioComCollectionIdSchema,
  title: z.string().min(1).max(300),
  imageUrl: ImageUrlSchema,
  tracks: z.array(AudioComTrackSchema).min(1).max(AUDIOCOM_COLLECTION_TRACKS_MAX),
});
export type AudioComHomeSection = z.infer<typeof AudioComHomeSectionSchema>;

/** GET /api/music/audiocom/featured: le sezioni della Home (vuoto se non ce ne sono). */
export const AudioComHomeResponseSchema = z.object({
  sections: z.array(AudioComHomeSectionSchema).max(AUDIOCOM_FEATURED_COLLECTIONS_MAX),
});
export type AudioComHomeResponse = z.infer<typeof AudioComHomeResponseSchema>;
