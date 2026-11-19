// @polsia:user-owned — unit del connettore "Riserva AI": auth a tempo costante, mappatura del
// modello, inoltro a Groq (upstream finto) con ripiego sul modello di scorta. Nessuna rete reale.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  activeProviders,
  authorizeReserve,
  bearerMatches,
  DEFAULT_RESERVE_MODEL,
  FALLBACK_RESERVE_MODEL,
  forwardChat,
  listModels,
  type ReserveChatBody,
  reserveProviderKeyNames,
  reserveProviderLabels,
  reserveStatusLabel,
  resolveModel,
} from '@/lib/business/ai-reserve-connector.server';

const SECRET = 'reserve-secret-abc';
const GROQ = 'gsk_test_key';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://solco.test/api/ai-reserve/v1/models', { headers });
}

function groqResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CHAT: ReserveChatBody = { messages: [{ role: 'user', content: 'ciao' }] };

function modelOf(call: unknown): string {
  const init = (call as [string, RequestInit])[1];
  return JSON.parse(String(init.body)).model as string;
}

describe('bearerMatches', () => {
  it('true solo per stringhe identiche', () => {
    expect(bearerMatches('abc', 'abc')).toBe(true);
    expect(bearerMatches('abc', 'abd')).toBe(false);
    expect(bearerMatches('abc', 'abcd')).toBe(false); // lunghezze diverse
    expect(bearerMatches('', '')).toBe(true);
  });
});

describe('authorizeReserve', () => {
  it('503 quando il segreto non è configurato', () => {
    expect(authorizeReserve(req({ authorization: `Bearer ${SECRET}` }), {})).toEqual({
      ok: false,
      status: 503,
      error: 'reserve_not_configured',
    });
  });

  it('401 senza header o con token sbagliato', () => {
    const env = { FREELLMAPI_API_KEY: SECRET };
    expect(authorizeReserve(req(), env)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeReserve(req({ authorization: 'Bearer nope' }), env)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorizeReserve(req({ authorization: SECRET }), env)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('ok con Bearer corretto, prefisso case-insensitive', () => {
    const env = { FREELLMAPI_API_KEY: SECRET };
    expect(authorizeReserve(req({ authorization: `Bearer ${SECRET}` }), env)).toEqual({ ok: true });
    expect(authorizeReserve(req({ authorization: `bearer ${SECRET}` }), env)).toEqual({ ok: true });
  });
});

describe('reserveStatusLabel', () => {
  it('mappa lo status di /models su un’etichetta di salute', () => {
    expect(reserveStatusLabel(200)).toBe('ok');
    expect(reserveStatusLabel(503)).toBe('unconfigured');
    expect(reserveStatusLabel(502)).toBe('down');
    expect(reserveStatusLabel(401)).toBe('down');
  });
});

describe('resolveModel', () => {
  it('"auto"/vuoto → default; esplicito → passthrough; env override', () => {
    expect(resolveModel(undefined, {})).toBe(DEFAULT_RESERVE_MODEL);
    expect(resolveModel('auto', {})).toBe(DEFAULT_RESERVE_MODEL);
    expect(resolveModel('AUTO', {})).toBe(DEFAULT_RESERVE_MODEL);
    expect(resolveModel('llama-x', {})).toBe('llama-x');
    expect(resolveModel('auto', { AI_RESERVE_MODEL: 'my-model' })).toBe('my-model');
  });
});

describe('forwardChat', () => {
  const env = { GROQ_API_KEY: GROQ };

  it('503 senza chiave upstream', async () => {
    const res = await forwardChat(CHAT, {}, vi.fn());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'upstream_not_configured' });
  });

  it('happy path: inoltra con il modello di default e passa la risposta così com’è', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(groqResponse({ choices: [{ message: { content: 'risposta' } }] }));
    const res = await forwardChat(CHAT, env, fetchMock);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('risposta');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(modelOf(fetchMock.mock.calls[0])).toBe(DEFAULT_RESERVE_MODEL);
  });

  it('modello ritirato (400) → riprova una volta con il modello di scorta', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(groqResponse({ error: { code: 'model_decommissioned' } }, 400))
      .mockResolvedValueOnce(groqResponse({ choices: [{ message: { content: 'ok' } }] }));
    const res = await forwardChat(CHAT, env, fetchMock);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(modelOf(fetchMock.mock.calls[0])).toBe(DEFAULT_RESERVE_MODEL);
    expect(modelOf(fetchMock.mock.calls[1])).toBe(FALLBACK_RESERVE_MODEL);
  });

  it('errore non-modello (500) → 502 senza ritentare', async () => {
    const fetchMock = vi.fn().mockResolvedValue(groqResponse({ error: 'boom' }, 500));
    const res = await forwardChat(CHAT, env, fetchMock);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rete che cade → 502 upstream_unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const res = await forwardChat(CHAT, env, fetchMock);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_unreachable' });
  });
});

describe('listModels', () => {
  it('503 senza chiave upstream', async () => {
    const res = await listModels({}, vi.fn());
    expect(res.status).toBe(503);
  });

  it('200 quando Groq risponde 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(groqResponse({ data: [{ id: 'llama' }] }));
    const res = await listModels({ GROQ_API_KEY: GROQ }, fetchMock);
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].id).toBe('llama');
  });

  it('401 di Groq (chiave invalida) → 502', async () => {
    const fetchMock = vi.fn().mockResolvedValue(groqResponse({ error: 'bad key' }, 401));
    const res = await listModels({ GROQ_API_KEY: GROQ }, fetchMock);
    expect(res.status).toBe(502);
  });

  it('upstream irraggiungibile → 502', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const res = await listModels({ GROQ_API_KEY: GROQ }, fetchMock);
    expect(res.status).toBe(502);
  });
});

/** Mock di fetch che smista per hostname: throw/Response per host, "unexpected" per gli altri. */
function byHost(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const host = new URL(String(input)).hostname;
    const handler = routes[host];
    if (!handler) throw new Error(`unexpected fetch ${String(input)}`);
    return handler();
  });
}

describe('activeProviders', () => {
  it('attiva solo i provider con chiave, nell’ordine del registro', () => {
    expect(activeProviders({}).map((p) => p.id)).toEqual([]);
    expect(activeProviders({ GROQ_API_KEY: GROQ }).map((p) => p.id)).toEqual(['groq']);
    expect(
      activeProviders({ GROQ_API_KEY: GROQ, OPENROUTER_API_KEY: 'or' }).map((p) => p.id),
    ).toEqual(['groq', 'openrouter']);
  });

  it('AI_RESERVE_PROVIDERS riordina e limita la catena; un id senza chiave è saltato', () => {
    expect(
      activeProviders({
        GROQ_API_KEY: GROQ,
        CEREBRAS_API_KEY: 'cb',
        AI_RESERVE_PROVIDERS: 'cerebras,groq',
      }).map((p) => p.id),
    ).toEqual(['cerebras', 'groq']);
    expect(
      activeProviders({ GROQ_API_KEY: GROQ, AI_RESERVE_PROVIDERS: 'gemini' }).map((p) => p.id),
    ).toEqual([]);
  });

  it('groq espone default e scorta come modelli «auto»', () => {
    const [groq] = activeProviders({ GROQ_API_KEY: GROQ });
    expect(groq?.models).toEqual([DEFAULT_RESERVE_MODEL, FALLBACK_RESERVE_MODEL]);
  });
});

describe('reserveProviderLabels / reserveProviderKeyNames', () => {
  it('etichette dei provider attivi e nomi di tutte le variabili-chiave note', () => {
    expect(reserveProviderLabels({ GROQ_API_KEY: GROQ })).toEqual(['Groq']);
    expect(reserveProviderLabels({})).toEqual([]);
    expect(reserveProviderKeyNames()).toEqual([
      'GROQ_API_KEY',
      'CEREBRAS_API_KEY',
      'GEMINI_API_KEY',
      'MISTRAL_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
  });
});

describe('forwardChat: failover fra provider', () => {
  const multi = { GROQ_API_KEY: GROQ, OPENROUTER_API_KEY: 'or_key' };

  it('Groq irraggiungibile → passa a OpenRouter e ne restituisce la risposta', async () => {
    const fetchMock = byHost({
      'api.groq.com': () => {
        throw new Error('ECONNRESET');
      },
      'openrouter.ai': () => groqResponse({ choices: [{ message: { content: 'da openrouter' } }] }),
    });
    const res = await forwardChat(CHAT, multi, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('da openrouter');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('Groq 429 (limitato) → passa subito a OpenRouter, senza lo scorta di Groq', async () => {
    const fetchMock = byHost({
      'api.groq.com': () => groqResponse({ error: { code: 'rate_limit_exceeded' } }, 429),
      'openrouter.ai': () => groqResponse({ choices: [{ message: { content: 'ok' } }] }),
    });
    const res = await forwardChat(CHAT, multi, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    const hosts = fetchMock.mock.calls.map((c) => new URL(String(c[0])).hostname);
    expect(hosts).toEqual(['api.groq.com', 'openrouter.ai']);
  });

  it('tutti i provider giù → 502 upstream_error con l’ultimo status', async () => {
    const fetchMock = byHost({
      'api.groq.com': () => groqResponse({ error: 'x' }, 500),
      'openrouter.ai': () => groqResponse({ error: 'y' }, 503),
    });
    const res = await forwardChat(CHAT, multi, fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_error', status: 503 });
  });
});

describe('listModels: failover fra provider', () => {
  it('Groq 500 → prova OpenRouter e torna 200', async () => {
    const fetchMock = byHost({
      'api.groq.com': () => groqResponse({ error: 'x' }, 500),
      'openrouter.ai': () => groqResponse({ data: [{ id: 'free-model' }] }),
    });
    const res = await listModels(
      { GROQ_API_KEY: GROQ, OPENROUTER_API_KEY: 'or' },
      fetchMock as unknown as typeof fetch,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].id).toBe('free-model');
  });
});
