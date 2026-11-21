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
  usesBuiltInConnector,
  verifyFreellmapi,
} from '@/lib/business/ai-freellmapi.server';

const KEY = 'fla_FAKEKEY0123456789';
const GROQ_KEY = 'gsk_test_key';
const BASE = 'https://app.test/api/ai-reserve/v1';
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const envWith = (over: Record<string, string | undefined> = {}) => ({
  FREELLMAPI_API_KEY: KEY,
  GROQ_API_KEY: GROQ_KEY,
  NEXT_PUBLIC_APP_URL: 'https://app.test',
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

describe('riserva: configurazione', () => {
  it('è configurata con chiave ben formata e l’URL pubblico di Solco (NEXT_PUBLIC_APP_URL)', () => {
    expect(freellmapiConfigured(envWith())).toBe(true);
    expect(freellmapiConfigured({})).toBe(false);
    // Senza l'URL di Solco non c'è dove ospitare il router.
    expect(freellmapiConfigured({ FREELLMAPI_API_KEY: KEY })).toBe(false);
    expect(freellmapiConfigured(envWith({ FREELLMAPI_API_KEY: undefined }))).toBe(false);
    expect(freellmapiConfigured(envWith({ FREELLMAPI_API_KEY: '   ' }))).toBe(false);
    expect(freellmapiConfigured(envWith({ FREELLMAPI_API_KEY: 'chiave con spazi' }))).toBe(false);
  });

  it('base URL: sempre il router di Solco; null senza NEXT_PUBLIC_APP_URL', () => {
    expect(freellmapiBaseUrl({})).toBeNull();
    expect(freellmapiBaseUrl({ NEXT_PUBLIC_APP_URL: 'https://app.test/' })).toBe(BASE);
    expect(usesBuiltInConnector({ NEXT_PUBLIC_APP_URL: 'https://app.test' })).toBe(true);
    expect(usesBuiltInConnector({})).toBe(false);
  });

  it('modello: predefinito «auto» e override', () => {
    expect(freellmapiModel({})).toBe('auto');
    expect(freellmapiModel({ FREELLMAPI_MODEL: 'llama-3.3-70b' })).toBe('llama-3.3-70b');
  });
});

describe('riserva: classificazione errori', () => {
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

describe('la rete gira solo su Solco: FREELLMAPI_BASE_URL non porta la riserva fuori', () => {
  const envBuiltIn = envWith;

  it('qualunque FREELLMAPI_BASE_URL è ignorata: router esterni, localhost, freellmapi.co', () => {
    for (const other of [
      'https://router.example/v1',
      'https://www.solcomusic.online/api/ai-reserve/v1',
      'https://freellmapi.co/v1',
      'http://localhost:3001/v1',
      'http://127.0.0.1:31415/models',
      'non-un-url',
    ]) {
      const env = envBuiltIn({ FREELLMAPI_BASE_URL: other });
      expect(freellmapiBaseUrl(env)).toBe(BASE);
      expect(usesBuiltInConnector(env)).toBe(true);
    }
  });

  it('chat con un router esterno configurato: nessuna chiamata a quel router', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ciao da groq' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const text = await freellmapiChat({
      messages: [{ role: 'user', content: 'x' }],
      env: envBuiltIn({ FREELLMAPI_BASE_URL: 'https://router.example/v1' }),
    });
    expect(text).toBe('ciao da groq');
    for (const [url] of fetchMock.mock.calls as unknown as [string][]) {
      expect(url).not.toContain('router.example');
    }
  });

  it('chat: col connettore interno chiama Groq in-process, non l’app (nessun loopback)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ciao da groq' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const text = await freellmapiChat({
      messages: [{ role: 'user', content: 'x' }],
      env: envBuiltIn({ FREELLMAPI_BASE_URL: 'http://127.0.0.1:31415/models' }),
    });
    expect(text).toBe('ciao da groq');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(url).not.toContain('app.test');
  });

  it('verifica: col connettore interno interroga Groq /models (200 → ok)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'llama' }] })),
    );
    const r = await verifyFreellmapi(envBuiltIn());
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
  });

  it('verifica: senza GROQ_API_KEY la riserva interna è spenta → warn', async () => {
    const r = await verifyFreellmapi(envBuiltIn({ GROQ_API_KEY: undefined }));
    expect(r.status).toBe('warn');
  });
});

describe('riserva: chat', () => {
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
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // In-process: dritto al provider gratuito, mai all'app (nessun loopback, nessun Bearer di Solco).
    expect(url).toBe(GROQ_CHAT);
    expect(url).not.toContain('app.test');
  });

  it('senza chiave lancia not_configured', async () => {
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: {} }),
    ).rejects.toMatchObject({ outcome: 'not_configured' });
  });

  it('provider che rifiuta (401), in errore (500) o irraggiungibile → busy (riprovabile)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toMatchObject({ outcome: 'busy', status: 502 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('err', { status: 500 })),
    );
    await expect(
      freellmapiChat({ messages: [{ role: 'user', content: 'x' }], env: envWith() }),
    ).rejects.toMatchObject({ outcome: 'busy', status: 502 });

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

describe('riserva: JSON', () => {
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

describe('riserva: verifica', () => {
  it('warn senza chiave o senza URL di Solco, ok con 200, fail con 401, fail se irraggiungibile', async () => {
    expect((await verifyFreellmapi({})).status).toBe('warn');
    // Chiave presente ma senza l'URL di Solco: avviso (non configurata), non guasto.
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
