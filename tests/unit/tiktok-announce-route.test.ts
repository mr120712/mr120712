// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  access: { allowed: true, user: { id: 'admin-1' } } as
    | { allowed: true; user: { id: string } }
    | { allowed: false; response: Response },
  sameOrigin: vi.fn(() => true),
  configured: vi.fn(() => true),
  generate: vi.fn(),
  limit: vi.fn(async () => null as Response | null),
}));

vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.limit,
  getRateLimitIdentity: () => 'id',
}));
vi.mock('@/lib/business/request-body.server', () => ({
  readJsonLimited: async (request: Request) => ({
    ok: true,
    value: await request.json().catch(() => ({})),
  }),
  limitedJsonError: () => Response.json({ error: 'too_large' }, { status: 413 }),
}));
vi.mock('@/lib/music/rights-admin.server', () => ({
  musicRightsPrivateHeaders: { 'Cache-Control': 'private, no-store' },
  requireVerifiedMusicRightsAdmin: async () => mocks.access,
}));
vi.mock('@/lib/business/tiktok-announce.server', () => ({
  tiktokAnnounceConfigured: mocks.configured,
  generateTikTokAnnouncement: mocks.generate,
}));

import { GET, POST } from '@/app/api/admin/tiktok/announce/route';

const announcement = {
  hook: 'Gancio',
  caption: 'Didascalia',
  hashtags: ['#solco'],
  script: {
    durationSeconds: 25,
    beats: [{ at: '0-3s', onScreen: 'a', voiceover: 'b', visual: 'c' }],
    cta: 'Prova',
  },
  soundIdea: 'trend lo-fi',
  altText: 'alt',
};

function req(method = 'GET', body?: unknown) {
  return new Request('https://solco.test/api/admin/tiktok/announce', {
    method,
    headers:
      method === 'POST'
        ? { origin: 'https://solco.test', 'content-type': 'application/json' }
        : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.access = { allowed: true, user: { id: 'admin-1' } };
  mocks.sameOrigin.mockReturnValue(true);
  mocks.configured.mockReturnValue(true);
  mocks.limit.mockResolvedValue(null);
  mocks.generate
    .mockReset()
    .mockResolvedValue({ ok: true, announcement, model: 'claude-sonnet-5-5' });
});

describe('GET /api/admin/tiktok/announce', () => {
  it('401 senza sessione admin', async () => {
    mocks.access = {
      allowed: false,
      response: Response.json({ error: 'unauthorized' }, { status: 401 }),
    };
    expect((await GET(req())).status).toBe(401);
  });

  it('200 con lo stato dell’IA per un admin', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).aiConfigured).toBe(true);
  });
});

describe('POST /api/admin/tiktok/announce', () => {
  it('403 su origine diversa (non chiama l’IA)', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(req('POST', {}))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('403 per non amministratori', async () => {
    mocks.access = {
      allowed: false,
      response: Response.json({ error: 'admin_required' }, { status: 403 }),
    };
    expect((await POST(req('POST', { angle: 'novita' }))).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('genera e ritorna 200 con annuncio + modello', async () => {
    const res = await POST(
      req('POST', { angle: 'promo', topic: 'radio dal vivo', genreSlug: 'techno' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.announcement.hook).toBe('Gancio');
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(mocks.generate).toHaveBeenCalled();
  });

  it('400 su genere sconosciuto (senza chiamare l’IA)', async () => {
    const res = await POST(req('POST', { genreSlug: 'boh' }));
    expect(res.status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('429 quando il rate limit scatta', async () => {
    mocks.limit.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await POST(req('POST', {}))).status).toBe(429);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('mappa gli esiti dell’IA sui codici giusti', async () => {
    const cases = [
      ['not_configured', 503],
      ['refused', 422],
      ['busy', 503],
      ['failed', 502],
    ] as const;
    for (const [error, status] of cases) {
      mocks.generate.mockResolvedValueOnce({ ok: false, error });
      expect((await POST(req('POST', { angle: 'community' }))).status).toBe(status);
    }
  });
});
