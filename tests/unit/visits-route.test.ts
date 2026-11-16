// @polsia:user-owned — POST /api/visits: solo dalla stessa origine (403), limite per IP (429),
// corpo piccolo e validato (400/413), 204 senza corpo quando la visita è registrata o ignorata,
// 503 se il registro non risponde; la route passa a recordVisit solo percorso, provenienza e
// intestazioni.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  enforceRateLimit: vi.fn(async () => null as Response | null),
  recordVisit: vi.fn(async (_input: unknown) => 'recorded' as 'recorded' | 'ignored'),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (_userId: string | null, headers: Headers) => {
    const ip = headers.get('x-real-ip');
    return ip ? `ip:${ip}` : null;
  },
}));
vi.mock('@/lib/admin/visitors.server', () => ({ recordVisit: mocks.recordVisit }));

import { POST } from '@/app/api/visits/route';

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://www.solcomusic.online/api/visits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://www.solcomusic.online',
        'x-real-ip': '203.0.113.7',
        'user-agent': 'Mozilla/5.0 Chrome/130',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.recordVisit.mockReset().mockResolvedValue('recorded');
});

describe('POST /api/visits', () => {
  it('registra la visita e risponde 204 senza corpo e senza cache', async () => {
    const response = await post({ path: '/search', referrer: 'https://www.google.com/' });
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(mocks.recordVisit).toHaveBeenCalledTimes(1);
    const input = mocks.recordVisit.mock.calls[0]?.[0] as {
      path: string;
      referrer?: string;
      headers: Headers;
    };
    expect(input.path).toBe('/search');
    expect(input.referrer).toBe('https://www.google.com/');
    expect(input.headers.get('x-real-ip')).toBe('203.0.113.7');
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('site.visit', 'ip:203.0.113.7');
  });

  it('anche una visita ignorata (robot, Do Not Track) risponde 204', async () => {
    mocks.recordVisit.mockResolvedValue('ignored');
    expect((await post({ path: '/' })).status).toBe(204);
  });

  it('403 da un’altra origine, senza registrare nulla', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await post({ path: '/' }, { origin: 'https://altro.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('429 oltre il limite per IP, prima di leggere il corpo', async () => {
    mocks.enforceRateLimit.mockResolvedValue(
      new Response('{"error":"rate_limited"}', { status: 429 }),
    );
    expect((await post({ path: '/' })).status).toBe(429);
    expect(mocks.recordVisit).not.toHaveBeenCalled();
  });

  it('senza indirizzo IP (ambiente locale) non applica il limite ma registra', async () => {
    const response = await POST(
      new Request('http://localhost:3000/api/visits', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ path: '/' }),
      }),
    );
    expect(response.status).toBe(204);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.recordVisit).toHaveBeenCalledTimes(1);
  });

  it('400 con un corpo non valido: niente percorso, chiavi in più, percorso troppo lungo, JSON rotto', async () => {
    for (const body of [
      {},
      { path: '/x', extra: 1 },
      { path: `/${'a'.repeat(300)}` },
      { path: 7 },
      { path: '/x', referrer: 'r'.repeat(3000) },
      'non json',
    ]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.recordVisit).not.toHaveBeenCalled();
  });

  it('413 con un corpo troppo grande', async () => {
    const response = await post({ path: '/', referrer: 'x'.repeat(5000) });
    expect(response.status).toBe(413);
    expect(mocks.recordVisit).not.toHaveBeenCalled();
  });

  it('503 se il registro delle visite non risponde, senza dettagli', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.recordVisit.mockRejectedValue(new Error('connection refused password=segreta'));
    const response = await post({ path: '/' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'visit_unavailable' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('segreta');
    error.mockRestore();
  });
});
