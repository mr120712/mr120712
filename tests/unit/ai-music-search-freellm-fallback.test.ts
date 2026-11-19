// @vitest-environment node
// La riserva gratuita (freellmapi.co) di «Cerca con l'AI»: quando Claude non è usabile, il piano
// arriva da freellmapi.co con lo stesso schema. Quando la riserva non è configurata, resta l'errore.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// Mock minimo dell'SDK: nel percorso senza chiave Claude non viene mai chiamato.
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status?: number) {
      super('api');
      this.status = status;
    }
  }
  class Anthropic {
    static APIError = APIError;
    static RateLimitError = class extends APIError {};
    static APIConnectionError = class extends APIError {};
    static APIConnectionTimeoutError = class extends APIError {};
    static APIUserAbortError = class extends APIError {};
    beta = { messages: { create: vi.fn() } };
    models = { list: vi.fn() };
  }
  return { default: Anthropic };
});
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', () => ({
  betaZodOutputFormat: () => ({ type: 'json_schema', schema: {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiMusicSearchCache: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => undefined),
    },
  },
}));

import { planMusicSearch } from '@/lib/business/ai-music-search.server';

const PLAN = {
  intro: 'Ho cercato techno ipnotica per concentrarti.',
  youtubeQueries: ['hypnotic techno mix'],
  audioQueries: ['techno'],
  radioTags: ['techno'],
  podcastQuery: null,
  genres: ['techno'],
};

function planResponse() {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(PLAN) } }] }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = ''; // Claude non configurato
  process.env.FREELLMAPI_API_KEY = 'fla_FAKEKEY0123456789';
  process.env.FREELLMAPI_BASE_URL = 'https://router.example/v1'; // router pubblico (obbligatorio)
  delete process.env.FREELLMAPI_MODEL;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe('Cerca con l’AI: riserva freellmapi.co', () => {
  it('senza Claude, il piano arriva dalla riserva', async () => {
    const fetchMock = vi.fn(async () => planResponse());
    vi.stubGlobal('fetch', fetchMock);
    const out = await planMusicSearch('techno per concentrarmi', 'user-1');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.plan.intro).toContain('techno');
      expect(out.plan.youtubeQueries.length).toBeGreaterThan(0);
    }
    // Ha chiamato l’endpoint OpenAI-compatibile del router configurato.
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe('https://router.example/v1/chat/completions');
  });

  it('senza Claude e senza riserva, resta not_configured', async () => {
    process.env.FREELLMAPI_API_KEY = '';
    const fetchMock = vi.fn(async () => planResponse());
    vi.stubGlobal('fetch', fetchMock);
    const out = await planMusicSearch('techno', 'user-1');
    expect(out).toEqual({ ok: false, error: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('se la riserva risponde male, resta not_configured (nessun piano inventato)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const out = await planMusicSearch('techno', 'user-1');
    expect(out).toEqual({ ok: false, error: 'not_configured' });
  });
});
