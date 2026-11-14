// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(
    async (_opts?: unknown) => ({ user: { id: 'u1' } }) as { user: { id: string } } | null,
  ),
  sameOrigin: vi.fn((_request?: unknown) => true),
  enforceRateLimit: vi.fn(async (_bucket?: string, _id?: string) => null as Response | null),
  getRateLimitIdentity: vi.fn(
    (_userId?: string | null, _headers?: unknown) => 'id-1' as string | null,
  ),
  readJson: vi.fn(async (_request?: unknown, _max?: number) => ({
    ok: true,
    value: { query: 'lofi' },
  })),
  consume: vi.fn(
    async (_user?: unknown) =>
      ({
        allowed: true,
        premium: false,
        used: 1,
        limit: 30,
        remaining: 29,
      }) as Record<string, unknown>,
  ),
  status: vi.fn(async (_user?: unknown) => ({ premium: false, used: 3, limit: 30, remaining: 27 })),
  botSearch: vi.fn(async (_query?: string) => [] as unknown[]),
}));

vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));
vi.mock('@/lib/business/request-body.server', () => ({ readJsonLimited: mocks.readJson }));
vi.mock('@/lib/business/bot-quota.server', () => ({
  consumeBotUse: mocks.consume,
  botQuotaStatus: mocks.status,
  FREE_MONTHLY_BOT_USES: 30,
}));
vi.mock('@/lib/music/bot-search.server', () => ({ botSearch: mocks.botSearch }));

import { GET, POST } from '@/app/api/bot/command/route';

function post() {
  return new Request('https://solco.test/api/bot/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}
function get() {
  return new Request('https://solco.test/api/bot/command', { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'u1' } });
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.getRateLimitIdentity.mockReturnValue('id-1');
  mocks.readJson.mockResolvedValue({ ok: true, value: { query: 'lofi' } });
  mocks.consume.mockResolvedValue({
    allowed: true,
    premium: false,
    used: 1,
    limit: 30,
    remaining: 29,
  });
  mocks.status.mockResolvedValue({ premium: false, used: 3, limit: 30, remaining: 27 });
  mocks.botSearch.mockResolvedValue([]);
});

describe('POST /api/bot/command', () => {
  it('403 se non same-origin (nessuna ricerca, nessun consumo)', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.botSearch).not.toHaveBeenCalled();
  });

  it('401 se non autenticato', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(post())).status).toBe(401);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('inoltra il rate-limit a raffica (429) senza consumare', async () => {
    mocks.enforceRateLimit.mockResolvedValue(new Response('slow', { status: 429 }));
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('400 su body non valido', async () => {
    mocks.readJson.mockResolvedValue({ ok: true, value: { query: '' } });
    expect((await POST(post())).status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('402 quando la quota mensile è esaurita (nessuna ricerca)', async () => {
    mocks.consume.mockResolvedValue({
      allowed: false,
      reason: 'quota_reached',
      used: 30,
      limit: 30,
      remaining: 0,
    });
    const res = await POST(post());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'quota_reached', used: 30, limit: 30, remaining: 0 });
    expect(mocks.botSearch).not.toHaveBeenCalled();
  });

  it('200 esegue la ricerca e restituisce i risultati + quota', async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.botSearch).toHaveBeenCalledWith('lofi');
    const body = await res.json();
    expect(body).toMatchObject({
      query: 'lofi',
      results: [],
      premium: false,
      used: 1,
      remaining: 29,
    });
  });
});

describe('GET /api/bot/command', () => {
  it('401 se non autenticato', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(401);
  });

  it('200 con lo stato della quota', async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ premium: false, used: 3, limit: 30, remaining: 27 });
  });
});
