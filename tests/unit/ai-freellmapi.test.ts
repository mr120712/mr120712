// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  classifyFreellmapiStatus,
  FreellmapiError,
  freellmapiBaseUrl,
  freellmapiChat,
  freellmapiConfigured,
  freellmapiJson,
  freellmapiModel,
  verifyFreellmapi,
} from '@/lib/business/ai-freellmapi.server';

const KEY = 'fla_FAKEKEY0123456789';
const BASE = 'https://router.example/v1';
const envWith = (over: Record<string, string | undefined> = {}) => ({
  FREELLMAPI_API_KEY: KEY,
  FREELLMAPI_BASE_URL: BASE,
  ...over,
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('freellmapi.co: configurazione', () => {
  it('è configurata solo con chiave ben formata E URL del router', () => {
    expect(freellmapiConfigured(envWith())).toBe(true);
    expect(freellmapiConfigured({})).toBe(false);
    // Chiave senza URL del router: non configurata (freellmapi è self-hosted, serve un endpoint).
    expect(freellmapiConfigured({ FREELLMAPI_API_KEY: KEY })).toBe(false);
    // URL senza chiave: non configurata.
    expect(freellmapiConfigured({ FREELLMAPI_BASE_URL: BASE })).toBe(false);
    expect(freellmapiConfigured(envWith({ FREELLMAPI_API_KEY: '   ' }))).toBe(false);
    expect(freellmapiConfigured(envWith({ FREELLMAPI_API_KEY: 'chiave con spazi' }))).toBe(false);
  });

  it('base URL: nessun default (null se assente), override senza slash finale', () => {
    expect(freellmapiBaseUrl({})).toBeNull();
    expect(freellmapiBaseUrl({ FREELLMAPI_BASE_URL: 'https://my.proxy/v1/' })).toBe(
      'https://my.proxy/v1',
    );
  });

  it('modello: predefinito «auto» e override', () => {
    expect(freellmapiModel({})).toBe('auto');
    expect(freellmapiModel({ FREELLMAPI_MODEL: 'llama-3.3-70b' })).toBe('llama-3.3-70b');
  });
});

describe('freellmapi.co: classificazione errori', () => {
  it('mappa gli status sulla semantica di Claude', () => {
    expect(classifyFreellmapiStatus(401)).toBe('not_configured');
    expect(classifyFreellmapiStatus(403)).toBe('not_configured');
    expect(classifyFreellmapiStatus(429)).toBe('busy');
    expect(classifyFreellmapiStatus(500)).toBe('busy');
    expect(classifyFreellmapiStatus(502)).toBe('busy');
    expect(classifyFreellmapiStatus(null)).toBe('busy');
    expect(classifyFreellmapiStatus(400)).toBe('failed');
    expect(classifyFreellmapiStatus(422)).toBe('failed');
  });
});

describe('freellmapi.co: chat', () => {
  it('ritorna il testo dell’assistente e chiama l’endpoint OpenAI-compatibile', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'Ciao!' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const text = await freellmapiChat({
      messages: [{ role: 'user', content: 'ping' }],
      env: envWith(),
    });
    expect(text).toBe('Ciao!');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('auto');
    expect(body.stream).toBe(false);
  });

  it('senza chiave lancia not_configured', async () => {
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: {} }),
    ).rejects.toMatchObject({ outcome: 'not_configured' });
  });

  it('401 → not_configured; 500 → busy; errore di rete → busy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toMatchObject({ outcome: 'not_configured', status: 401 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 500 })),
    );
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toMatchObject({ outcome: 'busy', status: 500 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toMatchObject({ outcome: 'busy' });
  });

  it('risposta vuota → failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: {} }] })),
    );
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toMatchObject({ outcome: 'failed' });
  });
});

describe('freellmapi.co: JSON', () => {
  it('estrae il JSON anche se avvolto in testo/```', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { content: 'Ecco:\n```json\n{"a":1,"b":"x"}\n```' } }],
        }),
      ),
    );
    const obj = await freellmapiJson<{ a: number; b: string }>({
      messages: [{ role: 'user', content: 'x' }],
      env: envWith(),
    });
    expect(obj).toEqual({ a: 1, b: 'x' });
  });

  it('riprova una volta e poi lancia se resta non-JSON', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'non è json' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      freellmapiJson({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toBeInstanceOf(FreellmapiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('freellmapi.co: verifica', () => {
  it('warn senza chiave o senza URL, ok con 200, fail con 401, fail se irraggiungibile', async () => {
    expect((await verifyFreellmapi({})).status).toBe('warn');
    // Chiave presente ma senza URL del router: avviso (non configurata), non guasto.
    expect((await verifyFreellmapi({ FREELLMAPI_API_KEY: KEY })).status).toBe('warn');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [] })),
    );
    const ok = await verifyFreellmapi(envWith({ FREELLMAPI_MODEL: 'llama-3.3-70b' }));
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain('llama-3.3-70b');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    expect((await verifyFreellmapi(envWith())).status).toBe('fail');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect((await verifyFreellmapi(envWith())).status).toBe('fail');
  });
});
