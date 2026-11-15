// @polsia:user-owned — suggerimenti AI di «Potrebbe piacerti» con l'SDK Anthropic vero (non simulato):
// la richiesta che parte davvero (Opus 5.5, fallback lato server, effort basso, schema rigido, solo
// nomi di artisti e generi racchiusi come dati), la pulizia dei suggerimenti (doppioni, caratteri di
// controllo, "because" solo tra gli artisti passati, id "song" uguali a quelli dei brani importati)
// e gli esiti di rifiuto, errore e chiave mancante. Nessuna rete: fetch è un registratore.
// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/music/collections.server', () => ({ isFavoritesName: () => false }));

import { songSourceId } from '@/lib/business/track-list-import.server';
import {
  MAX_AI_SUGGESTIONS,
  sanitizeSuggestions,
  suggestionPrompt,
  suggestRecommendedSongs,
} from '@/lib/music/recommendations-ai.server';

type Captured = { url: URL; headers: Headers; body: Record<string, unknown> | null };
const calls: Captured[] = [];
let respond: () => Response = () => {
  throw new Error('no response set');
};
/** true: la risposta non arriva mai, finché la richiesta non viene interrotta. */
let hang = false;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });
}

const suggestions = {
  suggestions: [
    { title: 'Brano Uno', artist: 'Artista Nuovo', because: 'Alfa' },
    { title: 'brano uno!', artist: 'ARTISTA NUOVO', because: 'Alfa' },
    { title: 'Brano\u0007 Due', artist: 'Altro', because: 'Sconosciuto' },
  ],
};
const message = (fields: Record<string, unknown> = {}) =>
  json(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_sequence: null,
    stop_details: null,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify(suggestions) }],
    ...fields,
  });

let keyCount = 0;

beforeAll(() => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname.endsWith('anthropic.com')) throw new Error('network call blocked in tests');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, headers: new Headers(init?.headers), body });
    if (hang) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return respond();
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', `sk-ant-api03-FAKE-not-a-real-key-reco-${++keyCount}`);
  calls.length = 0;
  hang = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('suggerimenti AI: la richiesta vera', () => {
  it('Opus 5.5, fallback lato server, effort basso, schema rigido e solo nomi racchiusi come dati', async () => {
    respond = () => message();
    const outcome = await suggestRecommendedSongs({ artists: ['Alfa', 'Beta'], genres: ['Lo-Fi'] });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url.pathname).toBe('/v1/messages');
    expect(call?.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = call?.body ?? {};
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    const schema = (body.output_config as { format: { schema: Record<string, unknown> } }).format
      .schema;
    expect(schema.additionalProperties).toBe(false);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(
      '<artisti>\n- Alfa\n- Beta\n</artisti>\n<generi>\nLo-Fi\n</generi>',
    );
  });

  it('pulisce i suggerimenti: niente doppioni né caratteri di controllo, "because" verificato', async () => {
    respond = () => message();
    const outcome = await suggestRecommendedSongs({ artists: ['Alfa'], genres: [] });
    expect(outcome).toEqual({
      ok: true,
      songs: [
        {
          qualifiedId: `song:${songSourceId('Brano Uno', 'Artista Nuovo')}`,
          title: 'Brano Uno',
          artistName: 'Artista Nuovo',
          seedArtist: 'Alfa',
        },
        {
          qualifiedId: `song:${songSourceId('Brano Due', 'Altro')}`,
          title: 'Brano Due',
          artistName: 'Altro',
          seedArtist: null,
        },
      ],
    });
  });

  it('rifiuto: nessun suggerimento', async () => {
    respond = () =>
      message({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: null, explanation: null },
        content: [],
      });
    expect(await suggestRecommendedSongs({ artists: ['Alfa'], genres: [] })).toEqual({
      ok: false,
      error: 'refused',
    });
  });

  it('servizio sovraccarico: "busy" (il motore restituisce il limite)', async () => {
    respond = () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } });
    expect(await suggestRecommendedSongs({ artists: ['Alfa'], genres: [] })).toEqual({
      ok: false,
      error: 'busy',
    });
  });

  it('tempo che resta alla richiesta: la chiamata viene interrotta in tempo ("busy", limiti restituiti)', async () => {
    hang = true;
    const started = Date.now();
    expect(
      await suggestRecommendedSongs({ artists: ['Alfa'], genres: [] }, new Date(), {
        timeoutMs: 50,
      }),
    ).toEqual({ ok: false, error: 'busy' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  });

  it('senza chiave o senza artisti: nessuna chiamata', async () => {
    respond = () => message();
    expect(await suggestRecommendedSongs({ artists: [], genres: ['Jazz'] })).toEqual({
      ok: true,
      songs: [],
    });
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await suggestRecommendedSongs({ artists: ['Alfa'], genres: [] })).toEqual({
      ok: false,
      error: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('pulizia e messaggio', () => {
  it('al massimo 10 suggerimenti', () => {
    const raw = {
      suggestions: Array.from({ length: 15 }, (_, index) => ({
        title: `Titolo ${index}`,
        artist: `Artista ${index}`,
        because: 'Alfa',
      })),
    };
    expect(sanitizeSuggestions(raw, ['Alfa'])).toHaveLength(MAX_AI_SUGGESTIONS);
  });

  it('il messaggio contiene al massimo 6 artisti e 3 generi, senza caratteri di controllo', () => {
    const prompt = suggestionPrompt({
      artists: ['A\u0000lfa', ...Array.from({ length: 9 }, (_, index) => `Art ${index}`)],
      genres: ['Jazz', 'Pop', 'Lo-Fi', 'Funk'],
    });
    expect(prompt).not.toContain('\u0000');
    expect(prompt.match(/^- /gm)).toHaveLength(6);
    expect(prompt).toContain('Jazz, Pop, Lo-Fi\n');
    expect(prompt).not.toContain('Funk');
  });
});
