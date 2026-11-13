// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  access: { allowed: true, user: { id: 'admin-1' } } as
    | { allowed: true; user: { id: string } }
    | { allowed: false; response: Response },
  sameOrigin: vi.fn(() => true),
  config: vi.fn((): { clientKey: string } | null => ({ clientKey: 'k' })),
  summary: vi.fn(),
  del: vi.fn(async () => undefined),
}));

vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/music/rights-admin.server', () => ({
  requireVerifiedMusicRightsAdmin: async () => mocks.access,
}));
vi.mock('@/lib/tiktok/config.server', () => ({
  tiktokConfig: mocks.config,
  tiktokPrivateHeaders: { 'Cache-Control': 'private, no-store' },
}));
vi.mock('@/lib/tiktok/connection.server', () => ({
  connectionSummary: mocks.summary,
  deleteConnection: mocks.del,
}));

import { DELETE, GET } from '@/app/api/admin/tiktok/connect/route';

function req(method = 'GET') {
  return new Request('https://solco.test/api/admin/tiktok/connect', {
    method,
    headers: method === 'DELETE' ? { origin: 'https://solco.test' } : undefined,
  });
}

beforeEach(() => {
  mocks.access = { allowed: true, user: { id: 'admin-1' } };
  mocks.sameOrigin.mockReturnValue(true);
  mocks.config.mockReturnValue({ clientKey: 'k' });
  mocks.summary.mockReset().mockResolvedValue({
    state: 'connected',
    openId: 'open-1',
    scope: 'user.info.basic,video.publish',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  mocks.del.mockReset().mockResolvedValue(undefined);
});

describe('GET /api/admin/tiktok/connect', () => {
  it('401 senza admin', async () => {
    mocks.access = {
      allowed: false,
      response: Response.json({ error: 'unauthorized' }, { status: 401 }),
    };
    expect((await GET(req())).status).toBe(401);
  });
  it('configured:false quando TikTok non è configurato', async () => {
    mocks.config.mockReturnValue(null);
    const body = await (await GET(req())).json();
    expect(body.configured).toBe(false);
    expect(body.state).toBe('none');
    expect(mocks.summary).not.toHaveBeenCalled();
  });
  it('200 con lo stato del collegamento', async () => {
    const body = await (await GET(req())).json();
    expect(body.configured).toBe(true);
    expect(body.state).toBe('connected');
    expect(body.openId).toBe('open-1');
  });
});

describe('DELETE /api/admin/tiktok/connect', () => {
  it('403 su origine diversa (non scollega)', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await DELETE(req('DELETE'))).status).toBe(403);
    expect(mocks.del).not.toHaveBeenCalled();
  });
  it('scollega e ritorna 200', async () => {
    const res = await DELETE(req('DELETE'));
    expect(res.status).toBe(200);
    expect((await res.json()).disconnected).toBe(true);
    expect(mocks.del).toHaveBeenCalledWith('admin-1');
  });
});
