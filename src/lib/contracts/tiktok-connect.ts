// @polsia:user-owned — contratti condivisi (client + route) per collegare Solco a TikTok (Login
// Kit v2) e pubblicare un video annunciato (Content Posting API, Direct Post).
import { z } from 'zod';

/** Livelli di privacy TikTok; l'admin ne sceglie uno fra quelli ammessi dal creator (nessun default). */
export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/** Etichette in italiano per il menu della privacy. */
export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: 'Pubblico (tutti)',
  MUTUAL_FOLLOW_FRIENDS: 'Amici (chi vi seguite a vicenda)',
  FOLLOWER_OF_CREATOR: 'Follower',
  SELF_ONLY: 'Solo io (privato)',
};

export const TikTokConnectionStatusSchema = z.object({
  configured: z.boolean(),
  state: z.enum(['none', 'connected', 'outdated', 'expired']),
  openId: z.string().nullable(),
  scope: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type TikTokConnectionStatus = z.infer<typeof TikTokConnectionStatusSchema>;

export const TikTokCreatorInfoSchema = z.object({
  nickname: z.string(),
  privacyLevelOptions: z.array(z.enum(TIKTOK_PRIVACY_LEVELS)),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
  maxVideoDurationSec: z.number(),
});
export type TikTokCreatorInfo = z.infer<typeof TikTokCreatorInfoSchema>;

export const TIKTOK_CAPTION_MAX = 2_200;

export const TikTokPublishRequestSchema = z.object({
  videoUrl: z
    .string()
    .trim()
    .url('Inserisci un URL del video valido.')
    .max(2_048)
    .refine(
      (value) => value.startsWith('https://'),
      'Il video deve essere su un URL https pubblico.',
    ),
  caption: z.string().trim().min(1, 'La didascalia è obbligatoria.').max(TIKTOK_CAPTION_MAX),
  privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS),
  disableComment: z.boolean().optional(),
  disableDuet: z.boolean().optional(),
  disableStitch: z.boolean().optional(),
});
export type TikTokPublishRequest = z.infer<typeof TikTokPublishRequestSchema>;

export const TikTokPublishResultSchema = z.object({ publishId: z.string() });

export const TikTokPublishStatusSchema = z.object({
  status: z.string(),
  failReason: z.string().nullable(),
  postId: z.string().nullable(),
});
