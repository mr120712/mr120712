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
import {
  AI_SEARCH_EXAMPLES,
  type AiSearchPlan,
  AiSearchPlanSchema,
} from '@/lib/contracts/ai-music-search';
import { prisma } from '@/lib/db';

const PLAN_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

// What Claude must return (structured output). Limits live in the prompt and in sanitizePlan.
const ClaudePlan = z.object({
  intro: z.string().describe('One or two warm sentences in Italian about what you searched for'),
  youtubeQueries: z.array(z.string()).describe('At most 2 precise YouTube music searches'),
  audioQueries: z.array(z.string()).describe('At most 2 short genre/mood searches for Audius'),
  radioTags: z.array(z.string()).describe('Up to 3 lowercase Radio Browser tags'),
  podcastQuery: z.string().nullable().describe('One podcast search, or null'),
  genres: z.array(z.string()).describe('Up to 4 slugs from the Solco genre list'),
});

/** The Anthropic key; also accepts the common misspelling ANTHROPHIC_API_KEY. */
export function anthropicApiKey(env: Record<string, string | undefined> = process.env) {
  return env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPHIC_API_KEY?.trim() || undefined;
}

export function aiSearchConfigured() {
  return Boolean(anthropicApiKey());
}

export type AiSearchOutcome =
  | { ok: true; plan: AiSearchPlan; cached: boolean }
  | { ok: false; error: 'not_configured' | 'refused' | 'busy' | 'failed' };

const SHARED_PROMPTS = new Set(AI_SEARCH_EXAMPLES.map((example) => normalizePrompt(example)));

/**
 * Plans are private to the listener who asked (nobody can probe what others searched);
 * only the ready-made examples are shared, since everyone sees those texts anyway.
 */
export function aiSearchCacheKey(prompt: string, userId: string) {
  const text = normalizePrompt(prompt);
  const scope = SHARED_PROMPTS.has(text) ? 'shared' : `user:${userId}`;
  return {
    key: createHash('sha256').update(`${scope}\n${text}`).digest('hex'),
    owner: SHARED_PROMPTS.has(text) ? null : userId,
  };
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

async function writeCache(key: string, owner: string | null, plan: AiSearchPlan, now: Date) {
  const data = {
    userId: owner,
    payload: plan as unknown as Prisma.InputJsonValue,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PLAN_CACHE_MS),
  };
  await Promise.resolve()
    .then(() =>
      prisma.aiMusicSearchCache.upsert({ where: { key }, create: { key, ...data }, update: data }),
    )
    .catch(() => undefined);
  // Keep the promise in the privacy policy: nothing older than 7 days stays stored.
  await Promise.resolve()
    .then(() => prisma.aiMusicSearchCache.deleteMany({ where: { expiresAt: { lte: now } } }))
    .catch(() => undefined);
}

// The route allows 120 s: a single attempt with a 100 s deadline always ends in time, and a
// slow turn is never paid twice by an automatic retry.
const REQUEST_TIMEOUT_MS = 100_000;

let client: Anthropic | null = null;
function anthropic() {
  client ??= new Anthropic({
    apiKey: anthropicApiKey(),
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return client;
}

function logRejectedKey() {
  // Shape of the configured key only (never its value), to diagnose a rejected key.
  const key = anthropicApiKey() ?? '';
  console.error('[solco] Anthropic key rejected', {
    length: key.length,
    standardKey: key.startsWith('sk-ant-api'),
    adminKey: key.startsWith('sk-ant-admin'),
    hasSpaces: /\s/.test(key),
    hasQuotes: /["']/.test(key),
    hasEquals: key.includes('='),
  });
}

/** Reads the structured plan; null when the text is not a valid plan. */
function readPlan(response: Anthropic.Beta.BetaMessage) {
  const text = response.content.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') return null;
  try {
    const parsed = ClaudePlan.safeParse(JSON.parse(text.text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function planMusicSearch(
  prompt: string,
  userId: string,
  now = new Date(),
): Promise<AiSearchOutcome> {
  if (!aiSearchConfigured()) return { ok: false, error: 'not_configured' };
  const { key, owner } = aiSearchCacheKey(prompt, userId);
  const cached = await readCache(key, now);
  if (cached) return { ok: true, plan: cached, cached: true };

  try {
    // `create` (not `parse`): a refusal can carry partial text, which `parse` would throw on
    // before stop_reason could be checked.
    const response = await anthropic().beta.messages.create(
      {
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
      },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + 5_000) },
    );
    if (response.stop_reason === 'refusal') return { ok: false, error: 'refused' };
    if (response.stop_reason !== 'end_turn') return { ok: false, error: 'failed' };
    const raw = readPlan(response);
    if (!raw) return { ok: false, error: 'failed' };
    const plan = sanitizePlan(raw);
    await writeCache(key, owner, plan, now);
    return { ok: true, plan, cached: false };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      logRejectedKey();
      return { ok: false, error: 'not_configured' };
    }
    if (
      error instanceof Anthropic.RateLimitError ||
      error instanceof Anthropic.APIConnectionTimeoutError ||
      error instanceof Anthropic.APIUserAbortError ||
      (error instanceof Anthropic.APIError && (error.status ?? 0) >= 500)
    ) {
      return { ok: false, error: 'busy' };
    }
    return { ok: false, error: 'failed' };
  }
}
