// @polsia:user-owned — ricerca musicale con Claude Opus 5.5 (SDK ufficiale Anthropic).
// La chiave è ANTHROPIC_API_KEY (segreto server-side su Vercel): ogni richiesta è a carico del
// proprietario di Solco, quindi la route richiede l'accesso, limita la frequenza e riusa i piani.
import 'server-only';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Prisma } from '@prisma/client';
import * as z from 'zod/v4';
import {
  AI_SEARCH_MODEL,
  AI_SEARCH_SYSTEM_PROMPT,
  aiSearchEffort,
  normalizePrompt,
  sanitizePlan,
} from '@/lib/business/ai-music-search';
import { type AiSearchPlan, AiSearchPlanSchema } from '@/lib/contracts/ai-music-search';
import { prisma } from '@/lib/db';

const PLAN_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// What Claude must return (structured output). Limits live in the prompt and in sanitizePlan.
const ClaudePlan = z.object({
  intro: z.string().describe('One or two warm sentences in Italian about what you searched for'),
  youtubeQueries: z.array(z.string()).describe('At most 2 precise YouTube music searches'),
  audioQueries: z
    .array(z.string())
    .describe('At most 2 short genre/mood searches for Audius and Jamendo'),
  radioTags: z.array(z.string()).describe('Up to 3 lowercase Radio Browser tags'),
  podcastQuery: z.string().nullable().describe('One podcast search, or null'),
  genres: z.array(z.string()).describe('Up to 4 slugs from the Solco genre list'),
});

export function aiSearchConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export type AiSearchOutcome =
  | { ok: true; plan: AiSearchPlan; cached: boolean }
  | { ok: false; error: 'not_configured' | 'refused' | 'busy' | 'failed' };

function cacheKey(prompt: string) {
  return createHash('sha256').update(normalizePrompt(prompt)).digest('hex');
}

async function readCache(key: string, now: Date) {
  try {
    const row = await prisma.aiMusicSearchCache.findUnique({ where: { key } });
    if (!row || row.expiresAt <= now) return null;
    const parsed = AiSearchPlanSchema.safeParse(row.payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, plan: AiSearchPlan, now: Date) {
  const data = {
    payload: plan as unknown as Prisma.InputJsonValue,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PLAN_CACHE_MS),
  };
  await Promise.resolve()
    .then(() =>
      prisma.aiMusicSearchCache.upsert({ where: { key }, create: { key, ...data }, update: data }),
    )
    .catch(() => undefined);
}

let client: Anthropic | null = null;
function anthropic() {
  // Reads ANTHROPIC_API_KEY. One retry; a plan must arrive while the listener waits.
  client ??= new Anthropic({ maxRetries: 1, timeout: 100_000 });
  return client;
}

export async function planMusicSearch(prompt: string, now = new Date()): Promise<AiSearchOutcome> {
  if (!aiSearchConfigured()) return { ok: false, error: 'not_configured' };
  const key = cacheKey(prompt);
  const cached = await readCache(key, now);
  if (cached) return { ok: true, plan: cached, cached: true };

  try {
    const response = await anthropic().beta.messages.parse({
      model: AI_SEARCH_MODEL,
      max_tokens: 16000,
      // A safety decline on Opus 5.5 is retried server-side on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: AI_SEARCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      output_config: {
        effort: aiSearchEffort(process.env.SOLCO_AI_SEARCH_EFFORT),
        format: betaZodOutputFormat(ClaudePlan),
      },
      messages: [
        {
          role: 'user',
          content: `Descrizione dell'ascoltatore:\n<descrizione>\n${prompt}\n</descrizione>`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return { ok: false, error: 'refused' };
    if (!response.parsed_output) return { ok: false, error: 'failed' };
    const plan = sanitizePlan(response.parsed_output);
    await writeCache(key, plan, now);
    return { ok: true, plan, cached: false };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError)
      return { ok: false, error: 'not_configured' };
    if (error instanceof Anthropic.RateLimitError) return { ok: false, error: 'busy' };
    if (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500) {
      return { ok: false, error: 'busy' };
    }
    return { ok: false, error: 'failed' };
  }
}
