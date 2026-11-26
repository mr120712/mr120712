// @polsia:user-owned — unit della rotta /api/cron/ytdlp-keepwarm: auth con CRON_SECRET, skip se
// YTDLP_SERVICE_URL manca, GET al worker /health mockato, e l'esito mappato su 200/502.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GET } from '@/app/api/cron/ytdlp-keepwarm/route';

const SECRET = 'ytdlp-keepwarm-cron-0123456789';
const WORKER = 'https://worker.example.com';

const ORIG = {
  CRON_SECRET: process.env.CRON_SECRET,
  YTDLP_SERVICE_URL: process.env.YTDLP_SERVICE_URL,
};

function req(bearer?: string) {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request('https://solco.example/api/cron/ytdlp-keepwarm', { headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = SECRET;
  process.env.YTDLP_SERVICE_URL = WORKER;
});

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('GET /api/cron/ytdlp-keepwarm', () => {
  it('401 senza Authorization o con secret sbagliato', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('sbagliato'))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('401 se CRON_SECRET manca o è troppo corto', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req(SECRET))).status).toBe(401);
    process.env.CRON_SECRET = 'corto';
    expect((await GET(req('corto'))).status).toBe(401);
  });

  it('skip senza errore se YTDLP_SERVICE_URL manca', async () => {
    delete process.env.YTDLP_SERVICE_URL;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe('skipped');
    expect(body.ok).toBe(true);
    expect(body.reason).toBe('ytdlp_service_url_not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skip se YTDLP_SERVICE_URL non è HTTPS pubblico (anti-SSRF)', async () => {
    process.env.YTDLP_SERVICE_URL = 'http://127.0.0.1:8080';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('200 quando /health risponde 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, mode: 'serve' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe('pinged');
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(body.mode).toBe('serve');
    expect(fetchSpy).toHaveBeenCalledWith(
      `${WORKER}/health`,
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('502 quando /health risponde con status non-OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    const res = await GET(req(SECRET));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.action).toBe('pinged');
    expect(body.ok).toBe(false);
    expect(body.status).toBe(503);
  });

  it('502 quando la fetch lancia (timeout, DNS, rete)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );
    const res = await GET(req(SECRET));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('TimeoutError');
  });

  it("toglie la slash finale dall'URL", async () => {
    process.env.YTDLP_SERVICE_URL = `${WORKER}/`;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await GET(req(SECRET));
    expect(fetchSpy).toHaveBeenCalledWith(`${WORKER}/health`, expect.any(Object));
  });
});
