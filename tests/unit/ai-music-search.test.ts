// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  key: string;
  userId: string | null;
  payload: unknown;
  createdAt: Date;
  expiresAt: Date;
};

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  rows: new Map<string, Row>(),
  deleted: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status?: number) {
      super('api');
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionTimeoutError extends APIError {}
  class APIUserAbortError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIUserAbortError = APIUserAbortError;
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    beta = { messages: { create: mocks.create } };
  }
  return { default: Anthropic };
});
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', () => ({
  betaZodOutputFormat: () => ({ type: 'json_schema', schema: {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiMusicSearchCache: {
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) => mocks.rows.get(where.key) ?? null,
      ),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: Row }) => {
        mocks.rows.set(where.key, create);
        return create;
      }),
      deleteMany: mocks.deleted,
    },
  },
}));

import Anthropic from '@anthropic-ai/sdk';
import {
  AI_SEARCH_MODEL,
  aiSearchEffort,
  normalizePrompt,
  sanitizePlan,
} from '@/lib/business/ai-music-search';
import {
  aiSearchCacheKey,
  anthropicApiKey,
  planMusicSearch,
} from '@/lib/business/ai-music-search.server';
import { AI_SEARCH_EXAMPLES } from '@/lib/contracts/ai-music-search';

const rawPlan = {
  intro: '  Ho cercato lo-fi giapponese   tranquillo. ',
  youtubeQueries: ['japanese lofi', 'Japanese Lofi', 'city pop night', 'third'],
  audioQueries: ['lofi', 'chillhop', 'ambient'],
  radioTags: ['Lofi', 'chillout', 'jazz', 'quarto'],
  podcastQuery: null,
  genres: ['lofi', 'inventato', 'jazz'],
};
const ok = (plan: unknown = rawPlan) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(plan) }],
});

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
  mocks.create.mockReset();
  mocks.deleted.mockReset().mockResolvedValue({ count: 0 });
  mocks.rows.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe('ricerca con l’AI: regole', () => {
  it('limita le ricerche, toglie i doppioni e tiene solo generi esistenti', () => {
    const plan = sanitizePlan(rawPlan);
    expect(plan.intro).toBe('Ho cercato lo-fi giapponese tranquillo.');
    expect(plan.youtubeQueries).toEqual(['japanese lofi', 'city pop night']);
    expect(plan.audioQueries).toEqual(['lofi', 'chillhop']);
    expect(plan.radioTags).toEqual(['lofi', 'chillout', 'jazz']);
    expect(plan.genres.every((slug) => slug !== 'inventato')).toBe(true);
  });

  it('legge la chiave anche con il nome scritto male (ANTHROPHIC_API_KEY)', () => {
    expect(anthropicApiKey({ ANTHROPHIC_API_KEY: ' sk-x ' })).toBe('sk-x');
    expect(anthropicApiKey({ ANTHROPIC_API_KEY: 'sk-a', ANTHROPHIC_API_KEY: 'sk-b' })).toBe('sk-a');
    expect(anthropicApiKey({})).toBeUndefined();
  });

  it('usa Opus 5.5 con effort "high" se non configurato diversamente', () => {
    expect(AI_SEARCH_MODEL).toBe('claude-opus-5-5');
    expect(aiSearchEffort(undefined)).toBe('high');
    expect(aiSearchEffort('MAX')).toBe('max');
    expect(aiSearchEffort('ultra')).toBe('high');
    expect(normalizePrompt('  Lo-Fi   Notte ')).toBe('lo-fi notte');
  });

  it('i piani sono privati per utente, tranne quelli degli esempi pronti', () => {
    const mine = aiSearchCacheKey('jazz per cena', 'u1');
    const theirs = aiSearchCacheKey('jazz per cena', 'u2');
    expect(mine.key).not.toBe(theirs.key);
    expect(mine.owner).toBe('u1');
    const example = AI_SEARCH_EXAMPLES[0];
    expect(aiSearchCacheKey(example, 'u1')).toEqual(aiSearchCacheKey(` ${example} `, 'u2'));
    expect(aiSearchCacheKey(example, 'u1').owner).toBeNull();
  });
});

describe('ricerca con l’AI: chiamata a Claude', () => {
  it('chiede un piano strutturato con fallback, senza retry e con scadenza, e lo riusa', async () => {
    mocks.create.mockResolvedValue(ok());
    const first = await planMusicSearch('Lo-fi giapponese per studiare', 'u1');
    expect(first).toMatchObject({ ok: true, cached: false });
    const [request, options] = mocks.create.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'high' },
    });
    expect(request.thinking).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.deleted).toHaveBeenCalled();
    const again = await planMusicSearch('  lo-fi GIAPPONESE per studiare ', 'u1');
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(mocks.create).toHaveBeenCalledOnce();
    // Another listener does not get (or learn about) u1's plan.
    await planMusicSearch('Lo-fi giapponese per studiare', 'u2');
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('un rifiuto con testo parziale resta un rifiuto, un testo non valido è un errore', async () => {
    mocks.create.mockResolvedValueOnce({
      stop_reason: 'refusal',
      content: [{ type: 'text', text: '{"intro": "Mi disp' }],
    });
    expect(await planMusicSearch('qualcosa', 'u1')).toEqual({ ok: false, error: 'refused' });
    mocks.create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'non è JSON' }],
    });
    expect(await planMusicSearch('altro', 'u1')).toEqual({ ok: false, error: 'failed' });
    mocks.create.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [] });
    expect(await planMusicSearch('altro ancora', 'u1')).toEqual({ ok: false, error: 'failed' });
  });

  it('sovraccarico e tempo scaduto diventano "busy", chiave mancante "not_configured"', async () => {
    type ErrorClass = new (status?: number) => Error;
    const Errors = Anthropic as unknown as {
      RateLimitError: ErrorClass;
      APIConnectionTimeoutError: ErrorClass;
      APIError: ErrorClass;
    };
    mocks.create.mockRejectedValueOnce(new Errors.RateLimitError(429));
    expect(await planMusicSearch('a1', 'u1')).toEqual({ ok: false, error: 'busy' });
    mocks.create.mockRejectedValueOnce(new Errors.APIConnectionTimeoutError());
    expect(await planMusicSearch('a2', 'u1')).toEqual({ ok: false, error: 'busy' });
    mocks.create.mockRejectedValueOnce(new Errors.APIError(529));
    expect(await planMusicSearch('a3', 'u1')).toEqual({ ok: false, error: 'busy' });

    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await planMusicSearch('a4', 'u1')).toEqual({ ok: false, error: 'not_configured' });
  });
});
