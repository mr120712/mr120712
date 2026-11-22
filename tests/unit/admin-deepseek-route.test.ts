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
const env = { YTDLP_SERVICE_URL: 'https://worker.example.com/', YTDLP_SERVICE_KEY: 'k3y' };

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
    vi.stubEnv('YTDLP_SERVICE_URL', '');
    const res = await POST(request(ask));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'worker_not_configured' });
  });

  it('inoltra al worker e restituisce la risposta con header privati', async () => {
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
    const [url, init] = fetchImpl.mock.calls[0];
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
