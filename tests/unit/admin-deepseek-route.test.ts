// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));

import { POST } from '@/app/api/admin/deepseek/route';
import {
  askDeepseek,
  deepseekSolcoBudgets,
  reserveFailure,
  solcoModel,
} from '@/lib/business/deepseek-chat.server';

const admin = { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true };
const env = {
  DEEPSEEK_BACKEND: 'worker',
  YTDLP_SERVICE_URL: 'https://worker.example.com/',
  YTDLP_SERVICE_KEY: 'k3y',
};

function request(body: unknown) {
  return new Request('https://solco.test/api/admin/deepseek', {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ask = { messages: [{ role: 'user' as const, content: 'ciao' }] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('POST /api/admin/deepseek', () => {
  it('nega origine estranea, anonimi, non admin e admin non verificati prima del worker', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request(ask))).status).toBe(403);

    mocks.getSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: { ...admin, role: 'user' } })
      .mockResolvedValueOnce({ user: { ...admin, emailVerified: false } });
    expect((await POST(request(ask))).status).toBe(401);
    expect((await POST(request(ask))).status).toBe(403);
    expect((await POST(request(ask))).status).toBe(403);

    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rifiuta conversazioni che non finiscono con una richiesta', async () => {
    const res = await POST(request({ messages: [{ role: 'assistant', content: 'x' }] }));
    expect(res.status).toBe(400);
  });

  it('senza URL/chiave del worker risponde 503 worker_not_configured', async () => {
    vi.stubEnv('DEEPSEEK_BACKEND', 'worker');
    vi.stubEnv('YTDLP_SERVICE_URL', '');
    const res = await POST(request(ask));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'worker_not_configured' });
  });

  it('inoltra al worker e restituisce la risposta con header privati', async () => {
    vi.stubEnv('DEEPSEEK_BACKEND', 'worker');
    vi.stubEnv('YTDLP_SERVICE_URL', env.YTDLP_SERVICE_URL);
    vi.stubEnv('YTDLP_SERVICE_KEY', env.YTDLP_SERVICE_KEY);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, { reply: 'salve', model: 'ds' }));
    const res = await POST(request({ ...ask, system: 'Sii breve.' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: 'salve', model: 'ds' });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('admin.deepseek', 'user:admin-1');
    fetchSpy.mockRestore();
  });
});

describe('askDeepseek', () => {
  it('chiama /chat con la chiave Bearer e il prompt di sistema in testa', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { reply: 'ok', model: 'm' }));
    const out = await askDeepseek({ ...ask, system: 'S', temperature: 0.2 }, env, fetchImpl);
    expect(out).toEqual({ status: 'ok', reply: 'ok', model: 'm' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://worker.example.com/chat');
    expect(init.headers.authorization).toBe('Bearer k3y');
    const sent = JSON.parse(init.body);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'S' });
    expect(sent.temperature).toBe(0.2);
  });

  it('rifiuta URL non HTTPS o interni (anti-SSRF)', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['http://worker.example.com', 'https://127.0.0.1', 'https://10.0.0.2']) {
      const out = await askDeepseek(ask, { ...env, YTDLP_SERVICE_URL: url }, fetchImpl);
      expect(out.status).toBe('not_configured');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, { detail: 'unauthorized' }, 'worker_unauthorized'],
    [503, { detail: 'worker not configured: set WORKER_API_KEY' }, 'worker_unauthorized'],
    [503, { detail: 'chat not configured: set DEEPSEEK_ENDPOINT_URL' }, 'chat_not_configured'],
    [503, { detail: 'busy' }, 'busy'],
    [504, { detail: 'upstream_unreachable' }, 'model_unreachable'],
    [502, { detail: 'upstream_http_500' }, 'model_error'],
  ])('mappa %i %j → %s', async (status, body, error) => {
    const out = await askDeepseek(ask, env, vi.fn().mockResolvedValue(json(status, body)));
    expect(out).toEqual({ status: 'failed', error });
  });

  it('timeout/rete → timeout; risposta vuota → bad_response', async () => {
    expect(await askDeepseek(ask, env, vi.fn().mockRejectedValue(new Error('x')))).toEqual({
      status: 'failed',
      error: 'timeout',
    });
    expect(
      await askDeepseek(ask, env, vi.fn().mockResolvedValue(json(200, { reply: ' ' }))),
    ).toEqual({ status: 'failed', error: 'bad_response' });
  });
});

describe('askDeepseek con DEEPSEEK_BACKEND=solco (default)', () => {
  const solcoEnv = { MWAPI_API_KEY: 'mw-key', GROQ_API_KEY: 'g-key' };
  const completion = (content: string) =>
    json(200, { model: 'claude-sonnet-5', choices: [{ message: { content } }] });

  it('è il default e passa dalla Riserva AI in-process (nessun worker)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ciao!'));
    const out = await askDeepseek({ ...ask, system: 'S' }, solcoEnv, fetchImpl);
    expect(out).toEqual({ status: 'ok', reply: 'ciao!', model: 'claude-sonnet-5' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    // Default MWAPI anche se c'è una chiave Groq: la chat usa solo mwapi,mwapi-2.
    expect(String(url)).toBe('https://api.mwapi.dev/v1/chat/completions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(url)).not.toContain('worker');
    const sent = JSON.parse(init.body);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'S' });
  });

  it('DEEPSEEK_SOLCO_PROVIDERS sceglie altri provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ok'));
    await askDeepseek(ask, { ...solcoEnv, DEEPSEEK_SOLCO_PROVIDERS: 'groq' }, fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('groq.com');
  });

  it('senza chiavi MWAPI → not_configured, anche con altre chiavi della Riserva', async () => {
    expect(await askDeepseek(ask, { GROQ_API_KEY: 'g' }, vi.fn())).toEqual({
      status: 'not_configured',
    });
  });

  it('DEEPSEEK_SOLCO_MODEL fissa il modello', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('ok'));
    await askDeepseek(ask, { ...solcoEnv, DEEPSEEK_SOLCO_MODEL: 'deepseek-r1' }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(init.body).model).toBe('deepseek-r1');
  });

  it('senza provider configurati → not_configured; errore upstream → model_error', async () => {
    expect(await askDeepseek(ask, {}, vi.fn())).toEqual({ status: 'not_configured' });
    const failing = vi.fn().mockResolvedValue(json(500, { error: 'x' }));
    expect(await askDeepseek(ask, solcoEnv, failing)).toEqual({
      status: 'failed',
      error: 'model_error',
    });
  });
});

describe('deepseekSolcoBudgets', () => {
  it('lascia a un solo tentativo quasi tutto il budget (MWAPI è lento)', () => {
    expect(deepseekSolcoBudgets(50_000)).toEqual({ chainMs: 50_000, attemptMs: 45_000 });
    expect(deepseekSolcoBudgets(110_000)).toEqual({ chainMs: 100_000, attemptMs: 95_000 });
  });

  it('ogni tentativo verso MWAPI ha ~45 s nel bot, non i 20 s di default della Riserva', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(
          json(200, { model: 'claude-sonnet-5', choices: [{ message: { content: 'ok' } }] }),
        );
      await askDeepseek(ask, { MWAPI_API_KEY: 'k' }, fetchImpl, 50_000);
      const caps = timeout.mock.calls.map(([ms]) => ms);
      expect(Math.max(...caps)).toBeGreaterThanOrEqual(40_000);
      expect(caps.every((ms) => ms <= 50_000)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('rifiuti del provider resi leggibili', () => {
  it.each([
    [401, 'provider_auth'],
    [403, 'provider_auth'],
    [402, 'provider_credit'],
    [404, 'model_not_found'],
    [400, 'model_not_found'],
    [429, 'provider_rate_limited'],
    [500, 'model_error'],
  ])('upstream %i → %s', (status, error) => {
    expect(reserveFailure({ error: 'upstream_error', status })).toBe(error);
  });

  it('OpenRouter senza credito (402) arriva fino al bot come provider_credit', async () => {
    const env = {
      OPENROUTER_API_KEY: 'or',
      DEEPSEEK_SOLCO_PROVIDERS: 'openrouter',
      DEEPSEEK_SOLCO_MODEL: 'deepseek/deepseek-v4.1-flash',
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json(402, { error: { message: 'Insufficient credits' } }));
    expect(await askDeepseek(ask, env, fetchImpl)).toEqual({
      status: 'failed',
      error: 'provider_credit',
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
  });
});

describe('solcoModel (DEEPSEEK_SOLCO_MODEL ripulito)', () => {
  it.each([
    ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'],
    ['https://openrouter.ai/deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'],
    ['https://openrouter.ai/models/deepseek/deepseek-v4.1-flash/', 'deepseek/deepseek-v4.1-flash'],
    ['https://openrouter.ai/deepseek/deepseek-v4.1-flash?tab=api', 'deepseek/deepseek-v4.1-flash'],
    ['"deepseek/deepseek-v4.1-flash"', 'deepseek/deepseek-v4.1-flash'],
    ['  claude-haiku-4-5-20251001  ', 'claude-haiku-4-5-20251001'],
    ['', 'auto'],
  ])('%j → %s', (raw, expected) => {
    expect(solcoModel({ DEEPSEEK_SOLCO_MODEL: raw })).toBe(expected);
  });

  it('il link incollato arriva a OpenRouter come ID nudo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(200, {
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ message: { content: 'ok' } }],
      }),
    );
    await askDeepseek(
      ask,
      {
        OPENROUTER_API_KEY: 'or',
        DEEPSEEK_SOLCO_PROVIDERS: 'openrouter',
        DEEPSEEK_SOLCO_MODEL: 'https://openrouter.ai/deepseek/deepseek-v4.1-flash',
      },
      fetchImpl,
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1].body).model).toBe(
      'deepseek/deepseek-v4.1-flash',
    );
  });
});
