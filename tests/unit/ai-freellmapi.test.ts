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
  isSelfHostedReserveUrl,
  usesBuiltInConnector,
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

  it('base URL: null quando manca tutto; override esterno senza slash finale', () => {
    expect(freellmapiBaseUrl({})).toBeNull();
    expect(freellmapiBaseUrl({ FREELLMAPI_BASE_URL: 'https://my.proxy/v1/' })).toBe(
      'https://my.proxy/v1',
    );
  });

  it('base URL: default al connettore interno su NEXT_PUBLIC_APP_URL', () => {
    // Senza override esplicito: si usa il connettore ospitato da Solco.
    expect(freellmapiBaseUrl({ NEXT_PUBLIC_APP_URL: 'https://app.test/' })).toBe(
      'https://app.test/api/ai-reserve/v1',
    );
    // 'freellmapi.co' non è un'API (404): ignorato → connettore interno.
    expect(
      freellmapiBaseUrl({
        NEXT_PUBLIC_APP_URL: 'https://app.test',
        FREELLMAPI_BASE_URL: 'https://freellmapi.co/v1',
      }),
    ).toBe('https://app.test/api/ai-reserve/v1');
    // Un router ESTERNO valido resta un override e vince sul connettore.
    expect(
      freellmapiBaseUrl({
        NEXT_PUBLIC_APP_URL: 'https://app.test',
        FREELLMAPI_BASE_URL: 'https://router.example/v1',
      }),
    ).toBe('https://router.example/v1');
    // Valore non-URL: ignorato → connettore interno.
    expect(
      freellmapiBaseUrl({ NEXT_PUBLIC_APP_URL: 'https://app.test', FREELLMAPI_BASE_URL: 'ciao' }),
    ).toBe('https://app.test/api/ai-reserve/v1');
  });

  it('configurata con la sola chiave quando c’è il connettore interno (NEXT_PUBLIC_APP_URL)', () => {
    expect(
      freellmapiConfigured({ FREELLMAPI_API_KEY: KEY, NEXT_PUBLIC_APP_URL: 'https://app.test' }),
    ).toBe(true);
    // Chiave senza URL pubblico dell'app e senza router esterno: non configurata.
    expect(freellmapiConfigured({ FREELLMAPI_API_KEY: KEY })).toBe(false);
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

describe('riserva: override non usabili → connettore interno (in-process)', () => {
  const BUILT_IN = 'https://app.test/api/ai-reserve/v1';
  const envBuiltIn = (over: Record<string, string | undefined> = {}) => ({
    FREELLMAPI_API_KEY: KEY,
    GROQ_API_KEY: 'gsk_test_key',
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    ...over,
  });

  it('ignora localhost/http/IP privati/host interni → usa il connettore interno', () => {
    for (const bad of [
      'http://127.0.0.1:31415/models', // il caso del proprietario
      'http://localhost:3001/v1',
      'https://localhost/v1',
      'http://my.proxy/v1', // http, non https
      'https://10.0.0.5/v1',
      'https://api.internal/v1',
      'https://box.local/v1',
      'non-un-url',
    ]) {
      const env = envBuiltIn({ FREELLMAPI_BASE_URL: bad });
      expect(freellmapiBaseUrl(env)).toBe(BUILT_IN);
      expect(usesBuiltInConnector(env)).toBe(true);
    }
  });

  it('self-host: FREELLMAPI_BASE_URL = l’URL di Solco → connettore interno, mai un giro HTTP', () => {
    for (const app of ['https://www.solcomusic.online', 'https://solcomusic.online']) {
      for (const raw of [
        'https://www.solcomusic.online/api/ai-reserve/v1',
        'https://solcomusic.online/api/ai-reserve/v1/',
        'https://WWW.SolcoMusic.online/api/ai-reserve/v1',
      ]) {
        const env = { NEXT_PUBLIC_APP_URL: app, FREELLMAPI_BASE_URL: raw };
        expect(freellmapiBaseUrl(env)).toBe(`${app}/api/ai-reserve/v1`);
        expect(usesBuiltInConnector(env)).toBe(true);
      }
    }
    // Anche sul dominio di NEXT_PUBLIC_APP_URL (anteprime, domini di riserva).
    const preview = {
      NEXT_PUBLIC_APP_URL: 'https://solco.polsia.app',
      FREELLMAPI_BASE_URL: 'https://solco.polsia.app/api/ai-reserve/v1',
    };
    expect(usesBuiltInConnector(preview)).toBe(true);
    // Non è self-host: altro percorso, http, query, dominio simile.
    for (const raw of [
      'https://www.solcomusic.online/api/ai-reserve/v2',
      'http://www.solcomusic.online/api/ai-reserve/v1',
      'https://www.solcomusic.online/api/ai-reserve/v1?x=1',
      'https://solcomusic.online.evil.example/api/ai-reserve/v1',
    ]) {
      expect(
        isSelfHostedReserveUrl(raw, { NEXT_PUBLIC_APP_URL: 'https://www.solcomusic.online' }),
      ).toBe(false);
    }
  });

  it('un router HTTPS pubblico resta un override esterno', () => {
    const env = envBuiltIn({ FREELLMAPI_BASE_URL: 'https://router.example/v1' });
    expect(freellmapiBaseUrl(env)).toBe('https://router.example/v1');
    expect(usesBuiltInConnector(env)).toBe(false);
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
