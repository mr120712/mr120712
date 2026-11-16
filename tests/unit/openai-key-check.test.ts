// @polsia:user-owned — «Verifica chiave OpenAI»: il WAV di silenzio generato sul server (intestazione
// RIFF/WAVE, PCM 16 bit mono 16 kHz, un secondo, campioni a zero), la prova a Whisper (stessa
// richiesta della trascrizione: endpoint, Bearer, model, file audio.wav; 2xx = chiave valida senza
// leggere il testo; 401/403 chiave non valida; 429 con insufficient_quota = crediti finiti, altrimenti
// limite; 5xx; rete; annullamento) e la route POST /api/admin/featured-rights/transcribe/check (stessa
// origine, admin verificato, chiave assente → 503 senza consumare limiti, limite per admin, risposta
// privata, messaggi senza «Trascrizione non riuscita», mai la chiave né il testo di OpenAI).
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), consume: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
vi.mock('@/lib/business/rate-limit.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/rate-limit.server')>()),
  consumeRateLimit: mocks.consume,
}));

import { POST as check } from '@/app/api/admin/featured-rights/transcribe/check/route';
import {
  TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
  TranscriptionCheckResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import {
  PROBE_SECONDS,
  probeMessage,
  probeWhisper,
  silentWav,
  WHISPER_ENDPOINT,
  WHISPER_MODEL,
} from '@/lib/music/whisper.server';

const ORIGIN = 'https://solco.test';
const PATH = '/api/admin/featured-rights/transcribe/check';
const KEY = 'sk-test-CHIAVE-SEGRETA-4b7e';
const UPSTREAM_DETAIL = `Incorrect API key provided: ${KEY}. Request id req_123`;
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

function upstream(status: number, message = UPSTREAM_DETAIL, code = 'x') {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), { status });
}

function quotaExceeded() {
  return upstream(
    429,
    `You exceeded your current quota, please check your plan and billing details. ${UPSTREAM_DETAIL}`,
    'insufficient_quota',
  );
}

function post(origin: string | null = ORIGIN, signal?: AbortSignal) {
  const headers = new Headers({ cookie: 'better-auth.session_token=fake' });
  if (origin) headers.set('origin', origin);
  return new Request(`${ORIGIN}${PATH}`, { method: 'POST', headers, signal });
}

let fetchMock: ReturnType<typeof vi.fn>;
let warns: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OPENAI_API_KEY', KEY);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.consume.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('silentWav', () => {
  it('un secondo di PCM 16 bit mono a 16 kHz, intestazione WAV corretta, campioni a zero', () => {
    const wav = silentWav();
    const text = (offset: number, length: number) =>
      String.fromCharCode(...wav.subarray(offset, offset + length));
    const view = new DataView(wav.buffer);
    expect(PROBE_SECONDS).toBe(1);
    expect(wav.length).toBe(44 + 16_000 * 2);
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(32_000);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
    expect(silentWav(0.1).length).toBe(44 + 1_600 * 2);
    expect(silentWav(0.5, 8_000).length).toBe(44 + 4_000 * 2);
  });
});

describe('probeWhisper', () => {
  it('stessa richiesta della trascrizione con il silenzio: 2xx = chiave valida, corpo ignorato', async () => {
    fetchMock.mockResolvedValueOnce(new Response('non json {', { status: 200 }));
    const result = await probeWhisper({ apiKey: KEY });
    expect(result).toMatchObject({ ok: true, model: WHISPER_MODEL });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.elapsedMs)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WHISPER_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(init.cache).toBe('no-store');
    const form = init.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(44 + 32_000);
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBeNull();
  });

  it('errori con i codici della trascrizione, mai la chiave né il testo di OpenAI', async () => {
    const cases: Array<[() => Promise<Response>, string, string]> = [
      [async () => upstream(401), 'invalid_key', 'chiave OpenAI non valida'],
      [async () => upstream(403), 'invalid_key', 'chiave OpenAI non valida'],
      [async () => quotaExceeded(), 'no_credit', 'crediti OpenAI esauriti'],
      [
        async () => upstream(429, `Rate limit reached for whisper-1. ${UPSTREAM_DETAIL}`),
        'rate_limited',
        'limite OpenAI raggiunto',
      ],
      [async () => upstream(503), 'unavailable', 'OpenAI ha un problema'],
      [
        async () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)),
        'no_response',
        'OpenAI non risponde',
      ],
    ];
    for (const [respond, code, text] of cases) {
      fetchMock.mockImplementationOnce(respond);
      const result = await probeWhisper({ apiKey: KEY });
      expect(result.ok, code).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe(code);
      expect(result.message).toContain(text);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain('Incorrect API key');
      expect(JSON.stringify(result)).not.toContain('exceeded your current quota');
    }
  });

  it('richiesta già annullata: non parte (notSent)', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await probeWhisper({ apiKey: KEY, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: 'no_response', notSent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('probeMessage', () => {
  it('toglie «Trascrizione non riuscita:» e lascia il resto con la maiuscola', () => {
    expect(
      probeMessage(
        'Trascrizione non riuscita: chiave OpenAI non valida (controlla OPENAI_API_KEY su Vercel).',
      ),
    ).toBe('Chiave OpenAI non valida (controlla OPENAI_API_KEY su Vercel).');
    expect(probeMessage('OpenAI non risponde, riprova tra poco.')).toBe(
      'OpenAI non risponde, riprova tra poco.',
    );
    expect(probeMessage('Trascrizione non riuscita: ')).toBe('Trascrizione non riuscita: ');
  });
});

describe('POST /api/admin/featured-rights/transcribe/check', () => {
  function expectPrivate(response: Response) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }

  it('origine diversa → 403; senza sessione → 401; non admin o non verificato → 403', async () => {
    const foreign = await check(post('https://altro.example'));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: 'forbidden_origin' });

    mocks.getSession.mockResolvedValueOnce(null);
    expect((await check(post())).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await check(post())).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, emailVerified: false } });
    expect((await check(post())).status).toBe(403);
    mocks.getSession.mockRejectedValueOnce(new Error('db giù'));
    expect((await check(post())).status).toBe(503);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('senza OPENAI_API_KEY → 503 con il messaggio della pagina, nessun limite consumato', async () => {
    vi.stubEnv('OPENAI_API_KEY', '  ');
    const response = await check(post());
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      error: 'transcription_not_configured',
      message: TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
    });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limite per admin raggiunto → 429 con Retry-After, nessuna chiamata a OpenAI', async () => {
    mocks.consume.mockResolvedValueOnce({
      allowed: false,
      status: 429,
      retryAfterSeconds: 1800,
      error: 'rate_limited',
      message: '',
    });
    const response = await check(post());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1800');
    expectPrivate(response);
    expect(response.headers.get('vary')).toBe('Cookie');
    const body = await response.json();
    expect(body.error).toBe('rate_limited');
    expect(body.message).toContain('le verifiche della chiave OpenAI');
    expect(mocks.consume).toHaveBeenCalledWith('lyrics.transcribe.check', 'user:admin-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chiave valida → 200 nel formato del contratto, privato', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: '', segments: [] }), { status: 200 }),
    );
    const response = await check(post());
    expect(response.status).toBe(200);
    expectPrivate(response);
    const body = TranscriptionCheckResponseSchema.parse(await response.json());
    expect(body.ok).toBe(true);
    expect(body.model).toBe('whisper-1');
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(mocks.consume).toHaveBeenCalledWith('lyrics.transcribe.check', 'user:admin-1');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(warns).not.toHaveBeenCalled();
  });

  it('chiave rifiutata, crediti finiti, limite di OpenAI: codice, stato e messaggio senza segreti', async () => {
    const cases: Array<[() => Promise<Response>, number, string, string]> = [
      [async () => upstream(401), 502, 'openai_invalid_key', 'Chiave OpenAI non valida'],
      [async () => quotaExceeded(), 402, 'openai_no_credit', 'Crediti OpenAI esauriti'],
      [async () => upstream(429), 429, 'openai_rate_limited', 'Limite OpenAI raggiunto'],
      [async () => upstream(500), 502, 'openai_unavailable', 'OpenAI ha un problema'],
      [
        async () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)),
        502,
        'openai_no_response',
        'OpenAI non risponde',
      ],
    ];
    for (const [respond, status, code, text] of cases) {
      fetchMock.mockImplementationOnce(respond);
      const response = await check(post());
      expect(response.status, code).toBe(status);
      expectPrivate(response);
      const body = await response.json();
      expect(body.error).toBe(code);
      expect(body.message.startsWith(text), body.message).toBe(true);
      expect(body.message).not.toContain('Trascrizione non riuscita');
      expect(JSON.stringify(body)).not.toContain(KEY);
      expect(JSON.stringify(body)).not.toContain('Incorrect API key');
      if (code === 'openai_rate_limited') expect(response.headers.get('retry-after')).toBe('60');
    }
    expect(warns).toHaveBeenCalledTimes(cases.length);
    const logged = JSON.stringify(warns.mock.calls);
    expect(logged).toContain('invalid_key');
    expect(logged).toContain('no_credit');
    expect(logged).not.toContain(KEY);
  });
});
