// @polsia:user-owned — contratto della ricerca musicale con l'AI (Claude Opus 5.5).
import { z } from 'zod';

export const AI_SEARCH_PROMPT_MAX = 300;

export const AiSearchRequestSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, 'Descrivi cosa vuoi ascoltare (almeno 3 caratteri).')
    .max(AI_SEARCH_PROMPT_MAX, `Massimo ${AI_SEARCH_PROMPT_MAX} caratteri.`),
});

export const AiSearchPlanSchema = z.object({
  intro: z.string(),
  youtubeQueries: z.array(z.string()),
  audioQueries: z.array(z.string()),
  radioTags: z.array(z.string()),
  podcastQuery: z.string().nullable(),
  genres: z.array(z.string()),
});
export type AiSearchPlan = z.infer<typeof AiSearchPlanSchema>;

export const AiSearchResponseSchema = z.object({
  plan: AiSearchPlanSchema,
  cached: z.boolean(),
});

export const AiSearchStatusSchema = z.object({ enabled: z.boolean() });
