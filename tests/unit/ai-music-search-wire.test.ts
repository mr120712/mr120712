// @polsia:user-owned — "Cerca con l'AI" con l'SDK Anthropic vero (non simulato): fissa la richiesta
// che parte davvero e come ogni risposta HTTP diventa un esito. Nessuna rete e nessuna chiave
// vera: fetch è sostituito da un registratore che risponde come l'API.
// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    aiMusicSearchCache: {
      findUnique: async () => null,
      upsert: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
  },
}));

import { aiSearchAvailable, planMusicSearch } from '@/lib/business/ai-music-search.server';

type Captured = { url: URL; headers: Headers; body: Record<string, unknown> | null };
const calls: Captured[] = [];
let respond: () => Response = () => {
  throw new Error('no response set');
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });
}

const plan = {
  intro: 'Ho cercato jazz rilassato.',
  youtubeQueries: ['relaxing jazz dinner'],
  audioQueries: ['jazz'],
  radioTags: ['jazz'],
  podcastQuery: null,
  genres: ['jazz'],
};
const message = (fields: Record<string, unknown>) =>
  json(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_sequence: null,
    stop_details: null,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify(plan) }],
    ...fields,
  });
const apiError = (status: number, type: string) =>
  json(status, { type: 'error', error: { type, message: 'test' }, request_id: 'req_test' });
// A full error body: `details.error_code` is where the SDK reads `error.errorCode` from, and the
// message is where it reads `error.apiMessage` from.
const apiErrorFull = (
  status: number,
  type: string,
  { message = 'test', code }: { message?: string; code?: string } = {},
) =>
  json(status, {
    type: 'error',
    error: { type, message, ...(code ? { details: { error_code: code } } : {}) },
    request_id: 'req_test',
  });

let keyCount = 0;
let prompts = 0;
const prompt = () => `jazz per una cena ${++prompts}`;

beforeAll(() => {
  // Local, unreachable base URL: even without the fetch stub nothing would leave this machine.
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname.endsWith('anthropic.com')) throw new Error('network call blocked in tests');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, headers: new Headers(init?.headers), body });
    return respond();
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  // A fresh fake key per test: a rejection remembered for one key does not leak into the next.
  vi.stubEnv('ANTHROPIC_API_KEY', `sk-ant-api03-FAKE-not-a-real-key-${++keyCount}`);
  calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('ricerca con l’AI: la richiesta vera', () => {
  it('Opus 5.5 con fallback lato server, prompt di sistema in cache e uno schema rigido', async () => {
    respond = () =>
      message({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: JSON.stringify(plan) },
        ],
      });
    expect(await planMusicSearch(prompt(), 'u1')).toMatchObject({ ok: true, cached: false });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url.pathname).toBe('/v1/messages');
    expect(call?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = call?.body ?? {};
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    const schema = (body.output_config as { format: { schema: Record<string, unknown> } }).format
      .schema;
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required as string[])].sort()).toEqual(
      ['audioQueries', 'genres', 'intro', 'podcastQuery', 'radioTags', 'youtubeQueries'].sort(),
    );
  });

  it('un blocco "fallback" prima del testo (risposta di un altro modello) è un piano valido', async () => {
    respond = () =>
      message({
        model: 'claude-opus-5',
        content: [
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
          { type: 'text', text: JSON.stringify(plan) },
        ],
      });
    expect(await planMusicSearch(prompt(), 'u1')).toMatchObject({ ok: true });
  });

  it('rifiuto e max_tokens', async () => {
    respond = () =>
      message({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
        content: [],
      });
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: 'refused' });
    respond = () =>
      message({
        stop_reason: 'max_tokens',
        content: [{ type: 'thinking', thinking: '', signature: 's' }],
      });
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: 'failed' });
  });
});

describe('ricerca con l’AI: ogni errore HTTP ha l’esito giusto', () => {
  it.each([
    [401, 'authentication_error', 'not_configured'],
    [402, 'billing_error', 'not_configured'],
    [403, 'permission_error', 'not_configured'],
    [404, 'not_found_error', 'not_configured'],
    [400, 'invalid_request_error', 'failed'],
    [429, 'rate_limit_error', 'busy'],
    [500, 'api_error', 'busy'],
    [529, 'overloaded_error', 'busy'],
  ])('HTTP %i (%s) → %s, senza nuovi tentativi automatici', async (status, type, outcome) => {
    respond = () => apiError(status, type);
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: outcome });
    expect(calls).toHaveLength(1);
    // Account problems are remembered: the next listener is not sent to Anthropic again.
    expect(await aiSearchAvailable()).toBe(outcome !== 'not_configured');
    expect(calls.filter((call) => call.url.pathname === '/v1/messages')).toHaveLength(1);
  });

  it('un 429 per il tetto di spesa mensile spegne la ricerca (non è "busy" da riprovare)', async () => {
    // enforced_spend_limit_reached is a persistent owner-side billing stop, not a passing spike.
    respond = () =>
      apiErrorFull(429, 'rate_limit_error', {
        message: 'Your monthly spend limit has been reached.',
        code: 'enforced_spend_limit_reached',
      });
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: 'not_configured' });
    expect(calls).toHaveLength(1);
    // Remembered: the next listener is not sent to Anthropic (no /v1/models probe either).
    expect(await aiSearchAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('il beta server-side-fallback non abilitato (400) spegne la ricerca invece di dire "Riprova"', async () => {
    respond = () =>
      apiErrorFull(400, 'invalid_request_error', {
        message:
          'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.',
      });
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: 'not_configured' });
    expect(calls).toHaveLength(1);
    expect(await aiSearchAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('un 400 generico (bug nella richiesta) resta "failed" e non spegne la ricerca', async () => {
    respond = () =>
      apiErrorFull(400, 'invalid_request_error', {
        message: 'messages: roles must alternate between "user" and "assistant"',
      });
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: 'failed' });
    // Not an account verdict: the key is not remembered as rejected, so the search stays offered
    // (a GET still probes /v1/models, where a non-auth error is treated as "unknown", not rejection).
    expect(await aiSearchAvailable()).toBe(true);
  });

  it('la verifica per GET usa GET /v1/models e spegne la ricerca con una chiave rifiutata', async () => {
    respond = () => apiError(401, 'authentication_error');
    expect(await aiSearchAvailable()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/v1/models');
    expect(calls[0]?.url.searchParams.get('limit')).toBe('1');
    expect(await planMusicSearch(prompt(), 'u1')).toEqual({ ok: false, error: 'not_configured' });
    expect(calls).toHaveLength(1);
  });

  it('se la rete non risponde la ricerca resta offerta', async () => {
    respond = () => {
      throw new TypeError('fetch failed');
    };
    expect(await aiSearchAvailable()).toBe(true);
  });
});
