// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getClassicsDecade: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn(),
}));

vi.mock('@/lib/music/classics.server', () => ({ getClassicsDecade: mocks.getClassicsDecade }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));

import { GET } from '@/app/api/music/classics/route';

const ok = { outcome: 'no_results', decade: '70s', label: 'Anni 70', tagline: 't', playlists: [] };

function req(url: string) {
  return new Request(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getRateLimitIdentity.mockReturnValue(null);
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('GET /api/music/classics', () => {
  it('passa lo slug del decennio valido', async () => {
    mocks.getClassicsDecade.mockResolvedValue(ok);
    const res = await GET(req('https://solco.example/api/music/classics?decade=70s'));
    expect(res.status).toBe(200);
    expect(mocks.getClassicsDecade).toHaveBeenCalledWith('70s');
  });

  it('un decennio sconosciuto diventa null (default lato server)', async () => {
    mocks.getClassicsDecade.mockResolvedValue({ ...ok, decade: '60s', label: 'Anni 60' });
    await GET(req('https://solco.example/api/music/classics?decade=2020'));
    expect(mocks.getClassicsDecade).toHaveBeenCalledWith(null);
  });

  it('rispetta il rate-limit con un’identità', async () => {
    mocks.getRateLimitIdentity.mockReturnValue('ip:1.2.3.4');
    mocks.enforceRateLimit.mockResolvedValue(new Response('slow', { status: 429 }));
    const res = await GET(req('https://solco.example/api/music/classics?decade=80s'));
    expect(res.status).toBe(429);
    expect(mocks.getClassicsDecade).not.toHaveBeenCalled();
  });
});
