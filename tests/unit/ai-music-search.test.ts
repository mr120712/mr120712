// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  rows: new Map<string, { key: string; payload: unknown; createdAt: Date; expiresAt: Date }>(),
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
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    beta = { messages: { parse: mocks.parse } };
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
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { key: string };
          create: { key: string; payload: unknown; createdAt: Date; expiresAt: Date };
        }) => {
          mocks.rows.set(where.key, create);
          return create;
        },
      ),
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
import { planMusicSearch } from '@/lib/business/ai-music-search.server';

const rawPlan = {
  intro: '  Ho cercato lo-fi giapponese   tranquillo. ',
  youtubeQueries: ['japanese lofi', 'Japanese Lofi', 'city pop night', 'third'],
  audioQueries: ['lofi', 'chillhop', 'ambient'],
  radioTags: ['Lofi', 'chillout', 'jazz', 'quarto'],
  podcastQuery: null,
  genres: ['lofi', 'inventato', 'jazz'],
};

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
  mocks.parse.mockReset();
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

  it('usa Opus 5.5 con effort "high" se non configurato diversamente', () => {
    expect(AI_SEARCH_MODEL).toBe('claude-opus-5-5');
    expect(aiSearchEffort(undefined)).toBe('high');
    expect(aiSearchEffort('MAX')).toBe('max');
    expect(aiSearchEffort('ultra')).toBe('high');
    expect(normalizePrompt('  Lo-Fi   Notte ')).toBe('lo-fi notte');
  });
});

describe('ricerca con l’AI: chiamata a Claude', () => {
  it('chiede un piano strutturato con fallback e lo riusa per la stessa descrizione', async () => {
    mocks.parse.mockResolvedValue({ stop_reason: 'end_turn', parsed_output: rawPlan });
    const first = await planMusicSearch('Lo-fi giapponese per studiare');
    expect(first).toMatchObject({ ok: true, cached: false });
    const request = mocks.parse.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      output_config: { effort: 'high' },
    });
    expect(request.thinking).toBeUndefined();
    const again = await planMusicSearch('  lo-fi GIAPPONESE per studiare ');
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(mocks.parse).toHaveBeenCalledOnce();
  });

  it('gestisce rifiuto, chiave mancante e sovraccarico senza lanciare errori', async () => {
    mocks.parse.mockResolvedValueOnce({ stop_reason: 'refusal', parsed_output: null });
    expect(await planMusicSearch('qualcosa')).toEqual({ ok: false, error: 'refused' });

    const RateLimitError = Anthropic.RateLimitError as unknown as new (status: number) => Error;
    mocks.parse.mockRejectedValueOnce(new RateLimitError(429));
    expect(await planMusicSearch('altro')).toEqual({ ok: false, error: 'busy' });

    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await planMusicSearch('altro ancora')).toEqual({ ok: false, error: 'not_configured' });
  });
});
