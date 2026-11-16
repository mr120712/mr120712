// @polsia:user-owned — «Solco AI»: il motore di trascrizione scelto dalle variabili (Groq con
// GROQ_API_KEY e whisper-large-v3 predefinito, GROQ_WHISPER_MODEL solo tra i modelli ammessi;
// OpenAI solo con LYRICS_AI_PROVIDER=openai), le etichette senza segreti, il WAV di silenzio
// generato sul server (intestazione RIFF/WAVE, PCM 16 bit mono 16 kHz, un secondo, campioni a zero),
// la prova al motore (stessa richiesta della trascrizione: endpoint di Groq, Bearer, model, file
// audio.wav; 2xx = chiave valida senza leggere il testo; 401/403 chiave non valida; 429 con
// insufficient_quota = crediti finiti, altrimenti limite; 5xx; rete; annullamento), i messaggi per
// servizio e la route POST /api/admin/featured-rights/transcribe/check (stessa origine, admin
// verificato, chiave assente → 503 senza consumare limiti, limite per admin, risposta privata nel
// contratto, messaggi senza «Trascrizione non riuscita», mai la chiave né il testo del servizio).
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
  SOLCO_AI_NAME,
  TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
  TranscriptionCheckResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import {
  activeTranscriptionEngine,
  configuredTranscriptionProviders,
  DEFAULT_ENGINE_ORDER,
  engineLabelForModel,
  GROQ_TARGET,
  GROQ_TRANSCRIPTION_ENDPOINT,
  isTranscriptionConfigured,
  OPENAI_TARGET,
  transcriptionEngineLabel,
  transcriptionEngineOrder,
  transcriptionKeyEnvName,
  transcriptionKeyEnvNames,
  transcriptionProvider,
} from '@/lib/music/transcription-provider.server';
import {
  PROBE_SECONDS,
  probeMessage,
  probeTranscription,
  silentWav,
  WHISPER_ENDPOINT,
  WHISPER_ERROR_MESSAGES,
  whisperErrorMessage,
} from '@/lib/music/whisper.server';

const ORIGIN = 'https://solco.test';
const PATH = '/api/admin/featured-rights/transcribe/check';
const KEY = 'gsk_test_CHIAVE_SEGRETA_4b7e';
const OPENAI_KEY = 'sk-test-CHIAVE-SEGRETA-openai-9c1d';
const UPSTREAM_DETAIL = `Invalid API Key ${KEY}. Request id req_123`;
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

function groq(env: Record<string, string | undefined> = {}) {
  const provider = transcriptionProvider({ GROQ_API_KEY: KEY, ...env });
  if (!provider) throw new Error('motore Groq atteso');
  return provider;
}

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
  vi.stubEnv('GROQ_API_KEY', KEY);
  vi.stubEnv('LYRICS_AI_PROVIDER', '');
  vi.stubEnv('GROQ_WHISPER_MODEL', '');
  vi.stubEnv('OPENAI_API_KEY', '');
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

describe('transcriptionProvider', () => {
  it('Groq con whisper-large-v3 per impostazione predefinita; OpenAI subentra come riserva', () => {
    const provider = transcriptionProvider({
      GROQ_API_KEY: ` ${KEY} `,
      OPENAI_API_KEY: OPENAI_KEY,
    });
    expect(provider).toMatchObject({
      id: 'groq',
      vendor: 'Groq',
      endpoint: GROQ_TRANSCRIPTION_ENDPOINT,
      model: 'whisper-large-v3',
      envName: 'GROQ_API_KEY',
      label: `${SOLCO_AI_NAME} (Groq)`,
      apiKey: KEY,
    });
    expect(GROQ_TRANSCRIPTION_ENDPOINT).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    // Solo la chiave OpenAI: una chiave qualunque accende Solco AI.
    expect(transcriptionProvider({ OPENAI_API_KEY: OPENAI_KEY })).toMatchObject({ id: 'openai' });
    expect(transcriptionProvider({ GROQ_API_KEY: '  ' })).toBeNull();
    expect(transcriptionProvider({})).toBeNull();
  });

  it('GROQ_WHISPER_MODEL solo tra i modelli ammessi', () => {
    expect(groq({ GROQ_WHISPER_MODEL: 'whisper-large-v3-turbo' }).model).toBe(
      'whisper-large-v3-turbo',
    );
    expect(groq({ GROQ_WHISPER_MODEL: 'gpt-4o-transcribe' }).model).toBe('whisper-large-v3');
    expect(groq({ GROQ_WHISPER_MODEL: '  ' }).model).toBe('whisper-large-v3');
  });

  it('LYRICS_AI_PROVIDER=openai: OpenAI whisper-1 per primo, Groq in riserva', () => {
    const provider = transcriptionProvider({
      LYRICS_AI_PROVIDER: ' OpenAI ',
      OPENAI_API_KEY: OPENAI_KEY,
      GROQ_API_KEY: KEY,
    });
    expect(provider).toMatchObject({
      id: 'openai',
      vendor: 'OpenAI',
      endpoint: WHISPER_ENDPOINT,
      model: 'whisper-1',
      label: 'OpenAI',
      apiKey: OPENAI_KEY,
    });
    // OpenAI scelto ma senza la sua chiave: Groq, che la chiave l'ha, resta come riserva.
    expect(
      transcriptionProvider({ LYRICS_AI_PROVIDER: 'openai', GROQ_API_KEY: KEY }),
    ).toMatchObject({ id: 'groq' });
    expect(transcriptionKeyEnvName({ LYRICS_AI_PROVIDER: 'openai' })).toBe('OPENAI_API_KEY');
    expect(transcriptionKeyEnvName({})).toBe('GROQ_API_KEY');
  });

  it('etichette senza segreti e stato di configurazione', () => {
    expect(transcriptionEngineLabel(groq())).toBe('Solco AI (Groq · whisper-large-v3)');
    expect(transcriptionEngineLabel({ label: 'OpenAI', model: 'whisper-1' })).toBe(
      'OpenAI (whisper-1)',
    );
    expect(activeTranscriptionEngine({ GROQ_API_KEY: KEY })).toBe(
      'Solco AI (Groq · whisper-large-v3)',
    );
    expect(activeTranscriptionEngine({})).toBeUndefined();
    expect(isTranscriptionConfigured({ GROQ_API_KEY: KEY })).toBe(true);
    expect(isTranscriptionConfigured({})).toBe(false);
    // Dall'ambiente del processo (stubbato nel beforeEach).
    expect(isTranscriptionConfigured()).toBe(true);
    expect(JSON.stringify(transcriptionEngineLabel(groq()))).not.toContain(KEY);
  });
});

describe('whisperErrorMessage', () => {
  it('nomina il servizio, la sua variabile e il suo pannello; OpenAI resta il predefinito', () => {
    expect(whisperErrorMessage('invalid_key', GROQ_TARGET)).toBe(
      'Trascrizione non riuscita: chiave Groq non valida (controlla GROQ_API_KEY su Vercel).',
    );
    expect(whisperErrorMessage('no_credit', GROQ_TARGET)).toContain('console.groq.com');
    expect(whisperErrorMessage('rate_limited', GROQ_TARGET)).toContain('limite Groq raggiunto');
    expect(WHISPER_ERROR_MESSAGES.invalid_key).toBe(
      'Trascrizione non riuscita: chiave OpenAI non valida (controlla OPENAI_API_KEY su Vercel).',
    );
    expect(WHISPER_ERROR_MESSAGES.no_credit).toContain('platform.openai.com');
    expect(whisperErrorMessage('invalid_response', OPENAI_TARGET)).toContain('risposta di OpenAI');
  });
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

describe('probeTranscription', () => {
  it('stessa richiesta della trascrizione, al motore scelto: 2xx = chiave valida, corpo ignorato', async () => {
    fetchMock.mockResolvedValueOnce(new Response('non json {', { status: 200 }));
    const result = await probeTranscription({ provider: groq() });
    expect(result).toMatchObject({
      ok: true,
      model: 'whisper-large-v3',
      engine: 'Solco AI (Groq · whisper-large-v3)',
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.elapsedMs)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GROQ_TRANSCRIPTION_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(init.cache).toBe('no-store');
    const form = init.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(44 + 32_000);
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect(form.get('language')).toBeNull();
  });

  it('usa il fetch iniettato e il modello scelto', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const result = await probeTranscription({
      provider: groq({ GROQ_WHISPER_MODEL: 'whisper-large-v3-turbo' }),
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true, model: 'whisper-large-v3-turbo' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const form = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
  });

  it('errori con i codici della trascrizione e il nome del servizio, mai la chiave né la risposta', async () => {
    const cases: Array<[() => Promise<Response>, string, string]> = [
      [async () => upstream(401), 'invalid_key', 'chiave Groq non valida'],
      [async () => upstream(403), 'invalid_key', 'chiave Groq non valida'],
      [async () => quotaExceeded(), 'no_credit', 'crediti Groq esauriti'],
      [
        async () => upstream(429, `Rate limit reached for whisper-large-v3. ${UPSTREAM_DETAIL}`),
        'rate_limited',
        'limite Groq raggiunto',
      ],
      [async () => upstream(413), 'too_large', 'file troppo grande per Groq'],
      [async () => upstream(400), 'rejected', 'Groq non ha accettato il file audio'],
      [async () => upstream(503), 'unavailable', 'Groq ha un problema'],
      [
        async () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)),
        'no_response',
        'Groq non risponde',
      ],
    ];
    for (const [respond, code, text] of cases) {
      fetchMock.mockImplementationOnce(respond);
      const result = await probeTranscription({ provider: groq() });
      expect(result.ok, code).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe(code);
      expect(result.message).toContain(text);
      expect(result.message).not.toContain('OpenAI');
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(JSON.stringify(result)).not.toContain('Invalid API Key');
      expect(JSON.stringify(result)).not.toContain('exceeded your current quota');
    }
  });

  it('richiesta già annullata: non parte (notSent)', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await probeTranscription({ provider: groq(), signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: 'no_response', notSent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('probeMessage', () => {
  it('toglie «Trascrizione non riuscita:» e lascia il resto con la maiuscola', () => {
    expect(
      probeMessage(
        'Trascrizione non riuscita: chiave Groq non valida (controlla GROQ_API_KEY su Vercel).',
      ),
    ).toBe('Chiave Groq non valida (controlla GROQ_API_KEY su Vercel).');
    expect(probeMessage('Groq non risponde, riprova tra poco.')).toBe(
      'Groq non risponde, riprova tra poco.',
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

  it('senza nessuna chiave → 503 con il messaggio della pagina, nessun limite consumato', async () => {
    vi.stubEnv('GROQ_API_KEY', '  ');
    const response = await check(post());
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      error: 'transcription_not_configured',
      message: TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
    });
    expect(TRANSCRIPTION_NOT_CONFIGURED_MESSAGE).toContain('GROQ_API_KEY');
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limite per admin raggiunto → 429 con Retry-After, nessuna chiamata al motore', async () => {
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
    expect(body.message).toContain('le verifiche di Solco AI');
    expect(mocks.consume).toHaveBeenCalledWith('lyrics.transcribe.check', 'user:admin-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('motore raggiunto → 200 nel formato del contratto, privato, verso Groq', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: '', segments: [] }), { status: 200 }),
    );
    const response = await check(post());
    expect(response.status).toBe(200);
    expectPrivate(response);
    const body = TranscriptionCheckResponseSchema.parse(await response.json());
    expect(body.ok).toBe(true);
    expect(body.model).toBe('whisper-large-v3');
    expect(body.engine).toBe('Solco AI (Groq · whisper-large-v3)');
    expect(body.engines).toEqual([
      {
        id: 'groq',
        label: 'Solco AI (Groq · whisper-large-v3)',
        ok: true,
        elapsedMs: body.elapsedMs,
        message: null,
      },
    ]);
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(mocks.consume).toHaveBeenCalledWith('lyrics.transcribe.check', 'user:admin-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GROQ_TRANSCRIPTION_ENDPOINT);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(warns).not.toHaveBeenCalled();
  });

  it('LYRICS_AI_PROVIDER=openai: la prova va a OpenAI con OPENAI_API_KEY', async () => {
    vi.stubEnv('LYRICS_AI_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', OPENAI_KEY);
    vi.stubEnv('GROQ_API_KEY', '');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const body = TranscriptionCheckResponseSchema.parse(await (await check(post())).json());
    expect(body).toMatchObject({ model: 'whisper-1', engine: 'OpenAI (whisper-1)' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WHISPER_ENDPOINT);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it('chiave rifiutata, crediti finiti, limite del servizio: codice, stato e messaggio senza segreti', async () => {
    const cases: Array<[() => Promise<Response>, number, string, string]> = [
      [async () => upstream(401), 502, 'transcription_invalid_key', 'Chiave Groq non valida'],
      [async () => quotaExceeded(), 402, 'transcription_no_credit', 'Crediti Groq esauriti'],
      [async () => upstream(429), 429, 'transcription_rate_limited', 'Limite Groq raggiunto'],
      [async () => upstream(500), 502, 'transcription_unavailable', 'Groq ha un problema'],
      [
        async () => Promise.reject(new TypeError(`fetch failed ${UPSTREAM_DETAIL}`)),
        502,
        'transcription_no_response',
        'Groq non risponde',
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
      expect(JSON.stringify(body)).not.toContain('Invalid API Key');
      if (code === 'transcription_rate_limited') {
        expect(response.headers.get('retry-after')).toBe('60');
      }
    }
    expect(warns).toHaveBeenCalledTimes(cases.length);
    const logged = JSON.stringify(warns.mock.calls);
    expect(logged).toContain('groq: invalid_key');
    expect(logged).toContain('no_credit');
    expect(logged).not.toContain(KEY);
  });

  it('più motori: le prove partono insieme; 200 col primo che funziona e l’esito di ciascuno', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'dgfakekey0123456789abcdef0123456789abcd');
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('https://api.groq.com') ? upstream(401) : new Response('{}', { status: 200 }),
    );
    const response = await check(post());
    expect(response.status).toBe(200);
    const body = TranscriptionCheckResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ model: 'nova-3', engine: 'Deepgram (nova-3)' });
    expect(body.engines.map((engine) => [engine.id, engine.ok])).toEqual([
      ['groq', false],
      ['deepgram', true],
    ]);
    expect(body.engines[0]?.message).toContain('Chiave Groq non valida');
    expect(body.engines[0]?.message).toContain('HTTP 401');
    expect(body.engines[1]?.message).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.startsWith('https://api.deepgram.com/v1/listen?'))).toBe(true);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain('dgfakekey');
  });

  it('più motori, nessuno funziona: il codice del primo e i motivi di tutti', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'dgfakekey0123456789abcdef0123456789abcd');
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('https://api.groq.com')
        ? upstream(401)
        : upstream(402, 'Insufficient credits for this project'),
    );
    const response = await check(post());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('transcription_invalid_key');
    expect(body.message).toContain('Nessun motore di Solco AI funziona.');
    expect(body.message).toContain('Chiave Groq non valida');
    expect(body.message).toContain('Crediti Deepgram esauriti');
    expect(JSON.stringify(body)).not.toContain('dgfakekey');
  });
});

describe('motori multipli', () => {
  it('ordine predefinito, solo i motori con la chiave; LYRICS_AI_ENGINES sceglie e ordina', () => {
    const env = { GROQ_API_KEY: KEY, DEEPGRAM_API_KEY: 'dg-fake', OPENAI_API_KEY: OPENAI_KEY };
    expect(configuredTranscriptionProviders(env).map((provider) => provider.id)).toEqual([
      'groq',
      'deepgram',
      'openai',
    ]);
    expect(
      configuredTranscriptionProviders({ ...env, LYRICS_AI_ENGINES: 'openai, deepgram' }).map(
        (provider) => provider.id,
      ),
    ).toEqual(['openai', 'deepgram']);
    // Nomi sconosciuti si ignorano: resta l'ordine predefinito.
    expect(
      configuredTranscriptionProviders({ ...env, LYRICS_AI_ENGINES: 'boh' }).map(
        (provider) => provider.id,
      ),
    ).toEqual(['groq', 'deepgram', 'openai']);
    expect(transcriptionEngineOrder({})).toEqual(DEFAULT_ENGINE_ORDER);
    expect(transcriptionEngineOrder({ LYRICS_AI_PROVIDER: 'openai' })[0]).toBe('openai');
    expect(transcriptionEngineOrder({ LYRICS_AI_ENGINES: 'deepgram;groq deepgram' })).toEqual([
      'deepgram',
      'groq',
    ]);
    expect(activeTranscriptionEngine(env)).toBe(
      'Solco AI (Groq · whisper-large-v3); riserva: Deepgram (nova-3), OpenAI (whisper-1)',
    );
    expect(transcriptionKeyEnvNames({ LYRICS_AI_ENGINES: 'deepgram' })).toEqual([
      'DEEPGRAM_API_KEY',
    ]);
    expect(transcriptionKeyEnvNames({})[0]).toBe('GROQ_API_KEY');
  });

  it('Cloudflare col solo token (account scoperto dopo) o con token e account; etichette dal modello', () => {
    const [tokenOnly] = configuredTranscriptionProviders({ CLOUDFLARE_API_TOKEN: 'tok' });
    expect(tokenOnly).toMatchObject({ id: 'cloudflare', endpoint: '', apiKey: 'tok' });
    expect(tokenOnly?.accountId).toBeUndefined();
    expect(configuredTranscriptionProviders({ CLOUDFLARE_ACCOUNT_ID: 'abc123def4567890' })).toEqual(
      [],
    );
    const [cloudflare] = configuredTranscriptionProviders({
      CLOUDFLARE_API_TOKEN: 'tok',
      CLOUDFLARE_ACCOUNT_ID: 'abc123def4567890',
    });
    expect(cloudflare).toMatchObject({
      id: 'cloudflare',
      protocol: 'cloudflare',
      accountId: 'abc123def4567890',
      endpoint:
        'https://api.cloudflare.com/client/v4/accounts/abc123def4567890/ai/run/@cf/openai/whisper-large-v3-turbo',
    });
    expect(engineLabelForModel('nova-3')).toBe('Deepgram (nova-3)');
    expect(engineLabelForModel('whisper-large-v3-turbo')).toBe(
      'Solco AI (Groq · whisper-large-v3-turbo)',
    );
    expect(engineLabelForModel('scribe_v1')).toBe('ElevenLabs (scribe_v1)');
    expect(engineLabelForModel('boh')).toBeUndefined();
    expect(engineLabelForModel(null)).toBeUndefined();
  });
});
