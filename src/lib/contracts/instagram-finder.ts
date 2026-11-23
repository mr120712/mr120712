// @polsia:user-owned — contratto del «Trova creator Instagram» (admin): richiesta e risultati.
import { z } from 'zod';

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export const InstagramFinderRequestSchema = z
  .object({
    brief: z.string().trim().min(3).max(500),
    hashtags: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
    usernames: z
      .array(
        z
          .string()
          .trim()
          .transform((value) => value.replace(/^@/, ''))
          .pipe(z.string().regex(USERNAME)),
      )
      .max(20)
      .default([]),
    minFollowers: z.number().int().min(0).max(1_000_000_000).optional(),
    maxFollowers: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .refine(
    (value) =>
      value.minFollowers === undefined ||
      value.maxFollowers === undefined ||
      value.minFollowers <= value.maxFollowers,
    { message: 'minFollowers > maxFollowers', path: ['maxFollowers'] },
  );

export type InstagramFinderRequest = z.infer<typeof InstagramFinderRequestSchema>;
export type InstagramFinderInput = z.input<typeof InstagramFinderRequestSchema>;

export const InstagramCreatorSchema = z.object({
  username: z.string(),
  /** true: dati letti da Meta (Business Discovery). false: solo suggerito dall'AI, numeri a 0. */
  verified: z.boolean(),
  name: z.string().nullable(),
  biography: z.string().nullable(),
  website: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  followers: z.number(),
  mediaCount: z.number(),
  avgLikes: z.number(),
  avgComments: z.number(),
  /** (like + commenti medi) / follower, 0–1. */
  engagementRate: z.number(),
  lastPostAt: z.string().nullable(),
  /** Hashtag o «manuale»: da dove è arrivato il profilo. */
  foundVia: z.array(z.string()),
  score: z.number(),
  reason: z.string(),
});
export type InstagramCreator = z.infer<typeof InstagramCreatorSchema>;

export const InstagramPostSchema = z.object({
  permalink: z.string(),
  caption: z.string(),
  likes: z.number(),
  comments: z.number(),
  hashtag: z.string(),
  timestamp: z.string().nullable(),
});
export type InstagramPost = z.infer<typeof InstagramPostSchema>;

export const InstagramFinderResponseSchema = z.object({
  /** "verified": API di Meta; "ai_only": Instagram non collegato, solo suggerimenti dell'AI. */
  mode: z.enum(['verified', 'ai_only']),
  summary: z.string(),
  hashtags: z.array(z.string()),
  creators: z.array(InstagramCreatorSchema),
  posts: z.array(InstagramPostSchema),
  checked: z.number(),
  skipped: z.number(),
  aiRanked: z.boolean(),
  warnings: z.array(z.string()),
});
export type InstagramFinderResponse = z.infer<typeof InstagramFinderResponseSchema>;
