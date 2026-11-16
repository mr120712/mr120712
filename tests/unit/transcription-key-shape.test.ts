// @polsia:user-owned — diagnosi di una chiave rifiutata dal motore di trascrizione, senza mai
// rivelarla: apiKeyShape (lunghezza, prefisso atteso gsk_/sk-, spazi, a capo, virgolette, caratteri
// della versione nascosta, lunghezza insolita per Groq), lo stato HTTP conservato negli errori del
// client Whisper (`status`) e il messaggio di «Verifica Solco AI» che li unisce (probeDiagnosis),
// anche nel monitoraggio.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  POST as check,
  probeDiagnosis,
} from '@/app/api/admin/featured-rights/transcribe/check/route';
import {
  apiKeyShape,
  GROQ_TARGET,
  transcriptionProvider,
} from '@/lib/music/transcription-provider.server';
import { probeTranscription, transcribeWithWhisper } from '@/lib/music/whisper.server';

const ORIGIN = 'https://solco.test';
/** Forma di una chiave Groq vera (56 caratteri), valore finto. */
const KEY = `gsk_${'t3stCHIAVEfinta'.repeat(4).slice(0, 52)}`;
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

function groq(apiKey = KEY) {
  const provider = transcriptionProvider({ GROQ_API_KEY: apiKey });
  if (!provider) throw new Error('motore Groq atteso');
  return provider;
}

function post() {
  return new Request(`${ORIGIN}/api/admin/featured-rights/transcribe/check`, {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: 'better-auth.session_token=fake' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GROQ_API_KEY', KEY);
  vi.stubEnv('LYRICS_AI_PROVIDER', '');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.consume.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('apiKeyShape', () => {
  it('lunghezza e prefisso, senza la chiave', () => {
    expect(KEY).toHaveLength(56);
    const shape = apiKeyShape({ id: 'groq', apiKey: KEY });
    expect(shape).toBe('56 caratteri, inizia con gsk_');
    expect(shape).not.toContain('CHIAVE');
    expect(apiKeyShape({ id: 'openai', apiKey: 'sk-proj-abc' })).toBe(
      '11 caratteri, inizia con sk-',
    );
  });

  it('segnala virgolette, spazi, a capo, prefisso sbagliato e lunghezza insolita per Groq', () => {
    expect(apiKeyShape({ id: 'groq', apiKey: `"${KEY}"` })).toBe(
      '58 caratteri, contiene virgolette, non inizia con gsk_, lunghezza insolita (le chiavi Groq hanno 56 caratteri)',
    );
    expect(apiKeyShape({ id: 'groq', apiKey: `${KEY.slice(0, 20)} ${KEY.slice(21)}` })).toBe(
      '56 caratteri, contiene spazi o a capo',
    );
    expect(apiKeyShape({ id: 'groq', apiKey: `${KEY}\n` })).toContain('spazi o a capo');
    expect(apiKeyShape({ id: 'groq', apiKey: 'sk-proj-abc' })).toBe(
      '11 caratteri, non inizia con gsk_, lunghezza insolita (le chiavi Groq hanno 56 caratteri)',
    );
    expect(apiKeyShape({ id: 'groq', apiKey: KEY.slice(0, 40) })).toBe(
      '40 caratteri, lunghezza insolita (le chiavi Groq hanno 56 caratteri)',
    );
    expect(apiKeyShape({ id: 'openai', apiKey: 'gsk_abc' })).toBe(
      '7 caratteri, non inizia con sk-',
    );
  });

  it('riconosce la versione nascosta copiata dalla lista delle chiavi', () => {
    const masked = apiKeyShape({ id: 'groq', apiKey: 'gsk_********************' });
    expect(masked).toContain('caratteri non ammessi');
    expect(masked).toContain('versione nascosta');
    expect(apiKeyShape({ id: 'groq', apiKey: 'gsk_…abcd' })).toContain('caratteri non ammessi');
    expect(apiKeyShape({ id: 'groq', apiKey: 'gsk_abc•••' })).toContain('caratteri non ammessi');
    expect(apiKeyShape({ id: 'groq', apiKey: KEY })).not.toContain('caratteri non ammessi');
  });
});

describe('stato HTTP negli errori del client', () => {
  it('ogni risposta del servizio porta il suo stato; rete e annullamento no', async () => {
    const audio = new Uint8Array([1, 2, 3]);
    for (const status of [401, 403, 429, 413, 400, 500, 503]) {
      fetchMock.mockResolvedValueOnce(new Response('{"error":{"message":"x"}}', { status }));
      const result = await transcribeWithWhisper({ audio, extension: 'mp3', apiKey: KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status, String(status)).toBe(status);
    }
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const network = await probeTranscription({ provider: groq() });
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.status).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    const aborted = await probeTranscription({ provider: groq(), signal: controller.signal });
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.status).toBeUndefined();
  });
});

describe('probeDiagnosis', () => {
  it('chiave rifiutata: stato HTTP e forma della chiave; altri errori: solo lo stato', () => {
    const provider = groq();
    const invalid = probeDiagnosis(provider, {
      error: 'invalid_key',
      status: 401,
      message:
        'Trascrizione non riuscita: chiave Groq non valida (controlla GROQ_API_KEY su Vercel).',
    });
    expect(invalid).toBe(
      'Chiave Groq non valida (controlla GROQ_API_KEY su Vercel). Groq ha risposto HTTP 401; la chiave su Vercel: 56 caratteri, inizia con gsk_.',
    );
    expect(invalid).not.toContain(KEY);
    expect(
      probeDiagnosis(provider, {
        error: 'unavailable',
        status: 503,
        message:
          'Trascrizione non riuscita: Groq ha un problema in questo momento, riprova tra poco.',
      }),
    ).toBe('Groq ha un problema in questo momento, riprova tra poco. (Groq: HTTP 503)');
    expect(
      probeDiagnosis(provider, {
        error: 'no_response',
        message: 'Trascrizione non riuscita: Groq non risponde, riprova tra poco.',
      }),
    ).toBe('Groq non risponde, riprova tra poco.');
    expect(
      probeDiagnosis(
        { ...GROQ_TARGET, label: 'Solco AI (Groq)', apiKey: '"gsk_x"' },
        {
          error: 'invalid_key',
          status: 403,
          message: 'Trascrizione non riuscita: chiave Groq non valida.',
        },
      ),
    ).toContain(
      'HTTP 403; la chiave su Vercel: 7 caratteri, contiene virgolette, non inizia con gsk_',
    );
  });

  it('la route lo usa: 401 di Groq → 502 con la diagnosi, senza la chiave', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: `Invalid API Key ${KEY}` } }), {
        status: 401,
      }),
    );
    const response = await check(post());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('transcription_invalid_key');
    expect(body.message).toBe(
      'Chiave Groq non valida (controlla GROQ_API_KEY su Vercel). Groq ha risposto HTTP 401; la chiave su Vercel: 56 caratteri, inizia con gsk_.',
    );
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
