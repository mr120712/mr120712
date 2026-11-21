// @polsia:user-owned — ricerca musicale con Claude Opus 5.5 (SDK ufficiale Anthropic).
// La chiave è ANTHROPIC_API_KEY (segreto server-side su Vercel): ogni richiesta è a carico del
// proprietario di Solco, quindi la route richiede l'accesso, limita la frequenza e riusa i piani.
// Stato della chiave, client SDK, classificazione errori e log vivono in ai-anthropic.server
// (un'unica fonte di verità, condivisa con "Organizza con l'AI").
import 'server-only';
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Prisma } from '@prisma/client';
import * as z from 'zod/v4';
import {
  AI_CLIENT_TIMEOUT_MS,
  aiKeyAvailable,
  aiKeyConfigured,
  anthropicApiKey,
  anthropicClient,
  classifyAnthropicError,
  keyUsable,
  logAiFailure,
  rememberKeyOk,
} from '@/lib/business/ai-anthropic.server';
import {
  FreellmapiError,
  freellmapiConfigured,
  freellmapiJson,
} from '@/lib/business/ai-freellmapi.server';
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

// Re-exported so the route, the monitor and the tests keep one import site for key state.
export { anthropicApiKey };
/**
 * Usable as far as this instance knows, without a network call. La funzione è attiva se è usabile la
 * chiave Claude OPPURE è configurata la riserva gratuita (ospitata da Solco): così, se il proprietario
 * imposta solo la riserva, «Cerca con l'AI» resta visibile.
 */
export function aiSearchConfigured(now = new Date()) {
  return aiKeyConfigured(now) || freellmapiConfigured();
}
/** Come `aiSearchConfigured`, ma interroga Anthropic una volta (GET /v1/models) se non controllata di recente. */
export async function aiSearchAvailable(now = new Date()) {
  return (await aiKeyAvailable(now)) || freellmapiConfigured();
}

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

// La riserva gratuita (ospitata da Solco) deve produrre lo STESSO oggetto ClaudePlan; i modelli aperti non
// hanno lo structured-output di Claude, quindi la forma la descriviamo nel prompt e la validiamo con zod.
const FREELLM_PLAN_INSTRUCTION = `Rispondi SOLO con un oggetto JSON con ESATTAMENTE queste chiavi:
{
  "intro": "una o due frasi calorose in italiano su cosa hai cercato",
  "youtubeQueries": ["al massimo 2 ricerche musicali precise per YouTube"],
  "audioQueries": ["al massimo 2 ricerche brevi di genere/atmosfera per Audius"],
  "radioTags": ["fino a 3 tag minuscoli per Radio Browser"],
  "podcastQuery": "una ricerca podcast come stringa, oppure null",
  "genres": ["fino a 4 slug dall'elenco generi di Solco"]
}
Nessun testo fuori dal JSON.`;

/**
 * Riserva gratuita: quando Claude non è disponibile (chiave assente, rifiutata, sopra budget o
 * occupato) prova a produrre lo stesso piano con la riserva ospitata da Solco. Best-effort: ritorna null se la
 * riserva non è configurata o non riesce, così resta l'esito di Claude. Mai usata per un rifiuto di
 * sicurezza di Claude. Scrive in cache come il percorso primario.
 */
async function planViaFreellm(
  prompt: string,
  cacheKey: string,
  owner: string | null,
  now: Date,
): Promise<AiSearchOutcome | null> {
  if (!freellmapiConfigured()) return null;
  try {
    const raw = await freellmapiJson<unknown>({
      messages: [
        { role: 'system', content: `${AI_SEARCH_SYSTEM_PROMPT}\n\n${FREELLM_PLAN_INSTRUCTION}` },
        {
          role: 'user',
          content: `Descrizione dell'ascoltatore:\n<descrizione>\n${prompt}\n</descrizione>`,
        },
      ],
      temperature: 0.4,
      maxTokens: 1200,
    });
    const parsed = ClaudePlan.safeParse(raw);
    if (!parsed.success) {
      logAiFailure('freellm_invalid_plan', undefined, {}, 'warn');
      return null;
    }
    const plan = sanitizePlan(parsed.data);
    await writeCache(cacheKey, owner, plan, now);
    return { ok: true, plan, cached: false };
  } catch (error) {
    logAiFailure(
      'freellm',
      error instanceof FreellmapiError ? undefined : error,
      { outcome: error instanceof FreellmapiError ? error.outcome : 'failed' },
      'warn',
    );
    return null;
  }
}

export async function planMusicSearch(
  prompt: string,
  userId: string,
  now = new Date(),
): Promise<AiSearchOutcome> {
  const apiKey = anthropicApiKey();
  const { key, owner } = aiSearchCacheKey(prompt, userId);
  const cached = await readCache(key, now);
  if (cached) return { ok: true, plan: cached, cached: true };

  // Claude è primario. Se la sua chiave non è usabile (assente, malformata o rifiutata di recente),
  // non lo chiamiamo (e non lo paghiamo): proviamo subito la riserva gratuita.
  if (!keyUsable(apiKey, now.getTime())) {
    return (
      (await planViaFreellm(prompt, key, owner, now)) ?? { ok: false, error: 'not_configured' }
    );
  }

  try {
    // `create` (not `parse`): a refusal can carry partial text, which `parse` would throw on
    // before stop_reason could be checked.
    const response = await anthropicClient().beta.messages.create(
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
      { signal: AbortSignal.timeout(AI_CLIENT_TIMEOUT_MS + 5_000) },
    );
    // Any answer means the key and the account work.
    rememberKeyOk(apiKey, now.getTime());
    const requestId = response._request_id ?? null;
    if (response.stop_reason === 'refusal') {
      logAiFailure(
        'refusal',
        undefined,
        { category: response.stop_details?.category ?? null, requestId },
        'warn',
      );
      return { ok: false, error: 'refused' };
    }
    if (response.stop_reason !== 'end_turn') {
      logAiFailure('stop_reason', undefined, {
        stopReason: response.stop_reason,
        model: response.model,
        usage: response.usage,
        requestId,
      });
      return { ok: false, error: 'failed' };
    }
    const raw = readPlan(response);
    if (!raw) {
      logAiFailure('invalid_plan', undefined, {
        model: response.model,
        blocks: response.content.map((block) => block.type),
        requestId,
      });
      return { ok: false, error: 'failed' };
    }
    const plan = sanitizePlan(raw);
    await writeCache(key, owner, plan, now);
    return { ok: true, plan, cached: false };
  } catch (error) {
    const outcome = classifyAnthropicError(error, apiKey, now.getTime());
    // Claude non disponibile (chiave rifiutata, sopra budget, occupato o errore): prova la riserva.
    if (outcome === 'not_configured' || outcome === 'busy' || outcome === 'failed') {
      const fallback = await planViaFreellm(prompt, key, owner, now);
      if (fallback) return fallback;
    }
    return { ok: false, error: outcome };
  }
}
