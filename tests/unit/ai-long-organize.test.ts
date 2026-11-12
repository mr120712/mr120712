// @polsia:user-owned — "Organizza con l'AI": la logica lato server (conteggio token, streaming,
// estrazione, errori) con un SDK Anthropic finto iniettato. Nessuna rete e nessuna chiave vera:
// anche `fetch` è un registratore che fallisce, a prova che nulla esce da questa macchina.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countTokens: vi.fn(),
  stream: vi.fn(),
  list: vi.fn(),
}));

vi.mock('server-only', () => ({}));
// Stessa gerarchia dell'SDK reale (un timeout è un errore di connessione; il 402 non ha una classe).
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
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class APIUserAbortError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
    static APIConnectionError = APIConnectionError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    static APIUserAbortError = APIUserAbortError;
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    beta = { messages: { countTokens: mocks.countTokens, stream: mocks.stream } };
    models = { list: mocks.list };
  }
  return { default: Anthropic };
});
vi.mock('@anthropic-ai/sdk/helpers/beta/zod', () => ({
  betaZodOutputFormat: () => ({ type: 'json_schema', schema: {} }),
}));

import Anthropic from '@anthropic-ai/sdk';
import {
  maxInputTokens,
  organizeAvailable,
  organizeLongText,
} from '@/lib/business/ai-long-organize.server';

// The mocked SDK's error classes take `(status?)`; cast so tsc accepts the test constructors.
type ErrorClass = new (status?: number) => Error;
const Errors = Anthropic as unknown as Record<'AuthenticationError' | 'RateLimitError', ErrorClass>;

type Song = { title: string; artist: string };
const message = (fields: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  _request_id: 'req_test',
  content: [{ type: 'text', text: JSON.stringify({ note: 'Trovati brani.', songs: [] }) }],
  ...fields,
});
const withSongs = (songs: Song[], note = 'Trovati brani.', fields: Record<string, unknown> = {}) =>
  message({ content: [{ type: 'text', text: JSON.stringify({ note, songs }) }], ...fields });
const streamOf = (msg: unknown) => ({ finalMessage: async () => msg });
const streamThrows = (error: unknown) => ({
  finalMessage: async () => {
    throw error;
  },
});

let keyCount = 0;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', `sk-ant-api03-FAKE-not-a-real-key-${++keyCount}`);
  vi.stubEnv('SOLCO_AI_LONG_MAX_INPUT_TOKENS', '');
  mocks.countTokens.mockReset().mockResolvedValue({ input_tokens: 5_000 });
  mocks.stream.mockReset();
  mocks.list.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Nessuna rete: se qualcosa provasse a chiamare fetch il test fallirebbe.
  fetchSpy = vi.fn(async () => {
    throw new Error('network call blocked in tests');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('organizeLongText: estrazione', () => {
  it('conta i token, chiama lo streaming e prepara le righe "Artista - Titolo"', async () => {
    mocks.stream.mockReturnValue(
      streamOf(
        withSongs([
          { title: 'Song A', artist: 'Artist X' },
          { title: 'Song B', artist: '' },
          // Duplicato (stessa identità): va tolto.
          { title: 'song a', artist: 'ARTIST X' },
        ]),
      ),
    );
    const result = await organizeLongText('una lunga scaletta...', 'u1');
    expect(result).toMatchObject({
      ok: true,
      tracks: [
        { title: 'Song A', artist: 'Artist X' },
        { title: 'Song B', artist: '' },
      ],
      trackListText: 'Artist X - Song A\nSong B',
      note: 'Trovati brani.',
      inputTokens: 5_000,
      approxUsd: 0.008,
      truncated: 0,
    });

    // count_tokens prima dello streaming, entrambi una sola volta.
    expect(mocks.countTokens).toHaveBeenCalledTimes(1);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    // La richiesta vera: Opus 5.5 in streaming, fallback lato server, schema rigido, system in cache.
    const body = mocks.stream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    // Il conteggio misura gli stessi system+messages della chiamata.
    const count = mocks.countTokens.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(count).toMatchObject({ model: 'claude-opus-5-5' });
    expect(count.messages).toBeTruthy();
    expect(count.system).toBeTruthy();
  });

  it('taglia l’elenco al tetto dei brani e conta gli scartati', async () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      title: `Brano ${i}`,
      artist: `Art ${i}`,
    }));
    mocks.stream.mockReturnValue(streamOf(withSongs(many)));
    const result = await organizeLongText('tanti brani', 'u1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tracks).toHaveLength(200);
      expect(result.truncated).toBe(5);
      expect(result.trackListText.split('\n')).toHaveLength(200);
    }
  });

  it('nessun brano trovato → "empty"', async () => {
    mocks.stream.mockReturnValue(streamOf(withSongs([])));
    expect(await organizeLongText('testo senza canzoni', 'u1')).toEqual({
      ok: false,
      error: 'empty',
    });
  });

  it('un rifiuto di sicurezza → "refused", il testo non valido → "failed"', async () => {
    mocks.stream.mockReturnValueOnce(
      streamOf(
        message({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
          content: [],
        }),
      ),
    );
    expect(await organizeLongText('x'.repeat(50), 'u1')).toEqual({ ok: false, error: 'refused' });

    mocks.stream.mockReturnValueOnce(
      streamOf(message({ content: [{ type: 'text', text: 'non è JSON' }] })),
    );
    expect(await organizeLongText('x'.repeat(50), 'u1')).toEqual({ ok: false, error: 'failed' });
  });
});

describe('organizeLongText: controllo dei costi', () => {
  it('rifiuta un testo oltre il tetto di token SENZA chiamare il modello (count_tokens)', async () => {
    mocks.countTokens.mockResolvedValueOnce({ input_tokens: 500_000 });
    const result = await organizeLongText('un testo enorme...', 'u1');
    expect(result).toEqual({
      ok: false,
      error: 'too_large',
      inputTokens: 500_000,
      maxInputTokens: 400_000,
    });
    // La chiamata costosa non parte.
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('il tetto è alzabile via env, ma mai oltre il contesto del modello (1M)', () => {
    expect(maxInputTokens({})).toBe(400_000);
    expect(maxInputTokens({ SOLCO_AI_LONG_MAX_INPUT_TOKENS: '900000' })).toBe(900_000);
    expect(maxInputTokens({ SOLCO_AI_LONG_MAX_INPUT_TOKENS: '5000000' })).toBe(1_000_000);
    expect(maxInputTokens({ SOLCO_AI_LONG_MAX_INPUT_TOKENS: 'abc' })).toBe(400_000);
  });
});

describe('organizeLongText: errori Anthropic (gestione condivisa)', () => {
  it('una chiave rifiutata (401) spegne la funzione e resta ricordata (stato condiviso)', async () => {
    mocks.countTokens.mockRejectedValueOnce(new Errors.AuthenticationError(401));
    expect(await organizeLongText('x'.repeat(50), 'u1')).toEqual({
      ok: false,
      error: 'not_configured',
    });
    expect(mocks.countTokens).toHaveBeenCalledTimes(1);

    // Ricordata: la chiamata successiva non raggiunge più Anthropic, e GET non la offre più.
    expect(await organizeLongText('x'.repeat(50), 'u1')).toEqual({
      ok: false,
      error: 'not_configured',
    });
    expect(mocks.countTokens).toHaveBeenCalledTimes(1);
    expect(await organizeAvailable()).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('un 429 normale è "busy" (riprovabile), non spegne la funzione', async () => {
    mocks.stream.mockReturnValue(streamThrows(new Errors.RateLimitError(429)));
    expect(await organizeLongText('x'.repeat(50), 'u1')).toEqual({ ok: false, error: 'busy' });
  });

  it('una chiave con la forma sbagliata non viene provata', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'non-una-chiave');
    expect(await organizeLongText('x'.repeat(50), 'u1')).toEqual({
      ok: false,
      error: 'not_configured',
    });
    expect(mocks.countTokens).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
