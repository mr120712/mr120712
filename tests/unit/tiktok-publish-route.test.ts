// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  access: { allowed: true, user: { id: 'admin-1' } } as
    | { allowed: true; user: { id: string } }
    | { allowed: false; response: Response },
  sameOrigin: vi.fn(() => true),
  config: vi.fn(
    (): {
      clientKey: string;
      clientSecret: string;
      appOrigin: string;
      redirectUri: string;
      secureCookies: boolean;
    } | null => ({
      clientKey: 'k',
      clientSecret: 's',
      appOrigin: 'https://solco.test',
      redirectUri: 'https://solco.test/cb',
      secureCookies: true,
    }),
  ),
  limit: vi.fn(async () => null as Response | null),
  accessToken: vi.fn(async () => 'tok'),
  creatorInfo: vi.fn(),
  initDirectPost: vi.fn(),
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
  requireVerifiedMusicRightsAdmin: async () => mocks.access,
}));
vi.mock('@/lib/tiktok/config.server', () => ({
  tiktokConfig: mocks.config,
  tiktokPrivateHeaders: { 'Cache-Control': 'private, no-store' },
  notConfiguredResponse: () => Response.json({ error: 'tiktok_not_configured' }, { status: 404 }),
}));
vi.mock('@/lib/tiktok/connection.server', () => ({ tiktokAccessTokenFor: mocks.accessToken }));
vi.mock('@/lib/tiktok/publish.server', () => ({
  queryCreatorInfo: mocks.creatorInfo,
  initDirectPost: mocks.initDirectPost,
}));

import { GET, POST } from '@/app/api/admin/tiktok/publish/route';
// Keep client.server + http.server REAL so instanceof TikTokError mapping works.
import { TikTokError } from '@/lib/tiktok/client.server';

function req(method = 'GET', body?: unknown) {
  return new Request('https://solco.test/api/admin/tiktok/publish', {
    method,
    headers:
      method === 'POST'
        ? { origin: 'https://solco.test', 'content-type': 'application/json' }
        : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  videoUrl: 'https://cdn.solco.test/a.mp4',
  caption: 'Prova #solco',
  privacyLevel: 'SELF_ONLY',
};

beforeEach(() => {
  mocks.access = { allowed: true, user: { id: 'admin-1' } };
  mocks.sameOrigin.mockReturnValue(true);
  mocks.config.mockReturnValue({
    clientKey: 'k',
    clientSecret: 's',
    appOrigin: 'https://solco.test',
    redirectUri: 'https://solco.test/cb',
    secureCookies: true,
  });
  mocks.limit.mockResolvedValue(null);
  mocks.accessToken.mockResolvedValue('tok');
  mocks.creatorInfo.mockReset().mockResolvedValue({
    nickname: 'Solco',
    privacyLevelOptions: ['SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoDurationSec: 180,
  });
  mocks.initDirectPost.mockReset().mockResolvedValue('pub-1');
});

describe('GET /api/admin/tiktok/publish (creator info)', () => {
  it('401 senza admin', async () => {
    mocks.access = {
      allowed: false,
      response: Response.json({ error: 'unauthorized' }, { status: 401 }),
    };
    expect((await GET(req())).status).toBe(401);
  });
  it('404 quando TikTok non è configurato', async () => {
    mocks.config.mockReturnValue(null);
    expect((await GET(req())).status).toBe(404);
  });
  it('200 con le opzioni di privacy', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).privacyLevelOptions).toEqual(['SELF_ONLY']);
  });
  it('mappa reauth su 401', async () => {
    mocks.accessToken.mockRejectedValueOnce(new TikTokError({ status: 401, reason: 'reauth' }));
    expect((await GET(req())).status).toBe(401);
  });
});

describe('POST /api/admin/tiktok/publish (direct post)', () => {
  it('403 su origine diversa (non pubblica)', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(req('POST', validBody))).status).toBe(403);
    expect(mocks.initDirectPost).not.toHaveBeenCalled();
  });
  it('403 per non amministratori', async () => {
    mocks.access = {
      allowed: false,
      response: Response.json({ error: 'admin_required' }, { status: 403 }),
    };
    expect((await POST(req('POST', validBody))).status).toBe(403);
  });
  it('429 quando il rate limit scatta', async () => {
    mocks.limit.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await POST(req('POST', validBody))).status).toBe(429);
    expect(mocks.initDirectPost).not.toHaveBeenCalled();
  });
  it('400 su URL non https', async () => {
    const res = await POST(req('POST', { ...validBody, videoUrl: 'http://x/a.mp4' }));
    expect(res.status).toBe(400);
    expect(mocks.initDirectPost).not.toHaveBeenCalled();
  });
  it('avvia il Direct Post e ritorna il publishId', async () => {
    const res = await POST(req('POST', validBody));
    expect(res.status).toBe(200);
    expect((await res.json()).publishId).toBe('pub-1');
    expect(mocks.initDirectPost).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ privacyLevel: 'SELF_ONLY', videoUrl: validBody.videoUrl }),
    );
  });
  it('mappa gli errori TikTok sui codici giusti', async () => {
    const cases = [
      ['url_ownership_unverified', 400],
      ['privacy_level_mismatch', 400],
      ['unaudited_public', 400],
      ['reauth', 401],
      ['rate_limited', 429],
      ['unavailable', 503],
    ] as const;
    for (const [reason, status] of cases) {
      mocks.initDirectPost.mockRejectedValueOnce(new TikTokError({ status: 400, reason }));
      expect((await POST(req('POST', validBody))).status).toBe(status);
    }
  });
});
