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
import { askDeepseek } from '@/lib/business/deepseek-chat.server';

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
