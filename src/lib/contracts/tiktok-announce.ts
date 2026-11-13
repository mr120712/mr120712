// @polsia:user-owned — contratto condiviso (client + route) del generatore di annunci TikTok
// scritti con Claude 5.5. Il testo lo scrive l'IA; l'amministratore lo rivede, lo copia e lo usa
// per girare e pubblicare il video su TikTok (TikTok non si pubblica dal server).
import { z } from 'zod';

export const TIKTOK_ANNOUNCE_TOPIC_MAX = 400;

/** Tagli disponibili per l'annuncio (il "perché" del video). */
export const TIKTOK_ANGLES = [
  { value: 'novita', label: 'Novità / lancio' },
  { value: 'funzionalita', label: 'Una funzionalità' },
  { value: 'community', label: 'Consiglio / community' },
  { value: 'promo', label: 'Promo / Premium' },
  { value: 'dietro-le-quinte', label: 'Dietro le quinte' },
] as const;

export type TikTokAngle = (typeof TIKTOK_ANGLES)[number]['value'];

export const TikTokAnnounceRequestSchema = z.object({
  /** Argomento specifico scelto dall'amministratore; se assente l'IA sceglie un messaggio efficace. */
  topic: z.string().trim().max(TIKTOK_ANNOUNCE_TOPIC_MAX).optional(),
  angle: z.enum(['novita', 'funzionalita', 'community', 'promo', 'dietro-le-quinte']).optional(),
  /** Genere musicale da evidenziare (slug del catalogo Solco), facoltativo. */
  genreSlug: z.string().trim().max(40).optional(),
});
export type TikTokAnnounceRequest = z.infer<typeof TikTokAnnounceRequestSchema>;

export const TikTokBeatSchema = z.object({
  /** Momento della scena, es. "0-3s". */
  at: z.string(),
  /** Testo in sovraimpressione. */
  onScreen: z.string(),
  /** Cosa dire a voce / in audio. */
  voiceover: z.string(),
  /** Cosa si vede. */
  visual: z.string(),
});
export type TikTokBeat = z.infer<typeof TikTokBeatSchema>;

export const TikTokAnnouncementSchema = z.object({
  /** Gancio per i primi secondi. */
  hook: z.string(),
  /** Didascalia pronta per il post. */
  caption: z.string(),
  /** Hashtag senza cancelletto duplicato (già con "#"). */
  hashtags: z.array(z.string()),
  script: z.object({
    durationSeconds: z.number(),
    beats: z.array(TikTokBeatSchema),
    cta: z.string(),
  }),
  /** Idea di suono/trend (descrizione, non un brano protetto). */
  soundIdea: z.string(),
  /** Descrizione per l'accessibilità del video. */
  altText: z.string(),
});
export type TikTokAnnouncement = z.infer<typeof TikTokAnnouncementSchema>;

/** Corpo della risposta 200 della route di generazione. */
export const TikTokAnnounceResultSchema = z.object({
  announcement: TikTokAnnouncementSchema,
  /** Il modello che ha risposto (riflette un eventuale fallback). */
  model: z.string(),
});

/** Stato del generatore: l'IA è configurata e pronta su questa istanza? */
export const TikTokAnnounceStatusSchema = z.object({
  aiConfigured: z.boolean(),
});
