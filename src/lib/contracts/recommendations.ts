// @polsia:user-owned — contratto di «Potrebbe piacerti» (GET /api/music/recommendations e
// POST /api/music/recommendations/feedback). Due tipi di brano: Audius riproducibile da Solco
// (solo Open Music License, playbackEligible) e "song" (artista + titolo, cercato su YouTube solo
// quando tocca a lui nel player). Nessun brano caricato o «In evidenza», nessun video YouTube.
import { z } from 'zod';
import { AudiusTrackFieldsSchema } from '@/lib/contracts/music';

/** Brani per pagina della riga (fra 12 e 20). */
export const RECOMMENDATION_PAGE_SIZE = 16;
/** Pagine richiedibili con «Altri consigli»: oltre si ricomincia da capo, con un altro ordine. */
export const RECOMMENDATION_MAX_PAGE = 50;
/** «Non mi interessa» conservati per utente: oltre, i più vecchi vengono dimenticati. */
export const RECOMMENDATION_HIDDEN_LIMIT = 300;

/**
 * - personal: «Potrebbe piacerti», dai tuoi ascolti, Preferiti, playlist e diario;
 * - starter: «Per iniziare», quando non c'è ancora abbastanza per consigliare (popolari + tendenze);
 * - popular: «Popolari su Solco», con i consigli personalizzati spenti in Impostazioni.
 */
export const RecommendationModeSchema = z.enum(['personal', 'starter', 'popular']);
export type RecommendationMode = z.infer<typeof RecommendationModeSchema>;

export const RecommendationReasonKindSchema = z.enum([
  'artist',
  'similar',
  'genre',
  'community',
  'trending',
  'ai',
]);
export type RecommendationReasonKind = z.infer<typeof RecommendationReasonKindSchema>;

export const RecommendationReasonSchema = z
  .object({ kind: RecommendationReasonKindSchema, text: z.string().min(1).max(120) })
  .strict();
export type RecommendationReason = z.infer<typeof RecommendationReasonSchema>;

const AUDIUS_QUALIFIED_ID = /^audius:[A-Za-z0-9_-]{1,128}$/;
const SONG_QUALIFIED_ID = /^song:[a-f0-9]{32}$/;

/** Brano Audius: i campi della riga Audius (riproduzione, attribuzione, licenza OML). */
export const RecommendedAudiusTrackSchema = AudiusTrackFieldsSchema.pick({
  id: true,
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
})
  .extend({
    kind: z.literal('audius'),
    qualifiedId: z.string().regex(AUDIUS_QUALIFIED_ID),
    // Solo brani che Solco può riprodurre: la rotta dello stream lo riverifica comunque.
    playbackEligible: z.literal(true),
    playbackReason: z.literal('ready'),
    genre: z.string().max(80).nullable(),
    reason: RecommendationReasonSchema,
  })
  .strict();
export type RecommendedAudiusTrack = z.infer<typeof RecommendedAudiusTrackSchema>;

/** Brano "song": solo artista e titolo; il player lo cerca su YouTube quando tocca a lui. */
export const RecommendedSongSchema = z
  .object({
    kind: z.literal('song'),
    qualifiedId: z.string().regex(SONG_QUALIFIED_ID),
    title: z.string().trim().min(1).max(200),
    artistName: z.string().trim().min(1).max(200),
    reason: RecommendationReasonSchema,
  })
  .strict();
export type RecommendedSong = z.infer<typeof RecommendedSongSchema>;

export const RecommendationItemSchema = z
  .discriminatedUnion('kind', [RecommendedAudiusTrackSchema, RecommendedSongSchema])
  .superRefine((item, context) => {
    if (item.kind === 'audius' && item.qualifiedId !== `audius:${item.id}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'L’identificativo qualificato deve appartenere allo stesso brano Audius.',
      });
    }
  });
export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;

export const RecommendationsResponseSchema = z
  .object({
    mode: RecommendationModeSchema,
    items: z.array(RecommendationItemSchema).max(RECOMMENDATION_PAGE_SIZE),
    page: z.number().int().min(0).max(RECOMMENDATION_MAX_PAGE),
    /** Pagina da chiedere con «Altri consigli»; null se non c'è altro da mostrare. */
    nextPage: z.number().int().min(0).max(RECOMMENDATION_MAX_PAGE).nullable(),
  })
  .strict();
export type RecommendationsResponse = z.infer<typeof RecommendationsResponseSchema>;

export const RecommendationsQuerySchema = z.object({
  page: z.coerce.number().int().min(0).max(RECOMMENDATION_MAX_PAGE).default(0),
  /** '0' = consigli personalizzati spenti su questo dispositivo (Impostazioni). */
  personal: z.enum(['0', '1']).default('1'),
});

/** Chiave di un brano consigliato: la stessa del suo qualifiedId. */
export const RecommendationItemKeySchema = z
  .string()
  .regex(/^(audius:[A-Za-z0-9_-]{1,128}|song:[a-f0-9]{32})$/);

export const RecommendationFeedbackSchema = z
  .object({
    kind: z.enum(['hide', 'unhide']),
    itemKey: RecommendationItemKeySchema,
  })
  .strict();
export type RecommendationFeedback = z.infer<typeof RecommendationFeedbackSchema>;

export const RecommendationFeedbackResponseSchema = z.object({ ok: z.literal(true) }).strict();
