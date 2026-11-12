// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getRecordPool: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn(),
}));

vi.mock('@/lib/music/record-pool.server', () => ({ getRecordPool: mocks.getRecordPool }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));

import { GET } from '@/app/api/music/pool/route';

function req(url: string) {
  return new Request(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getRateLimitIdentity.mockReturnValue(null);
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('GET /api/music/pool', () => {
  it('restituisce il pool (tutti i generi)', async () => {
    mocks.getRecordPool.mockResolvedValue({ outcome: 'no_results', genre: null, tracks: [] });
    const res = await GET(req('https://solco.example/api/music/pool'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'no_results', genre: null, tracks: [] });
    expect(mocks.getRecordPool).toHaveBeenCalledWith(null);
  });

  it('passa lo slug di genere valido', async () => {
    mocks.getRecordPool.mockResolvedValue({ outcome: 'no_results', genre: 'techno', tracks: [] });
    await GET(req('https://solco.example/api/music/pool?genre=techno'));
    expect(mocks.getRecordPool).toHaveBeenCalledWith('techno');
  });

  it('uno slug sconosciuto diventa "Tutti" (null)', async () => {
    mocks.getRecordPool.mockResolvedValue({ outcome: 'no_results', genre: null, tracks: [] });
    await GET(req('https://solco.example/api/music/pool?genre=pippo'));
    expect(mocks.getRecordPool).toHaveBeenCalledWith(null);
  });

  it('rispetta il rate-limit quando c’è un’identità', async () => {
    mocks.getRateLimitIdentity.mockReturnValue('ip:1.2.3.4');
    mocks.enforceRateLimit.mockResolvedValue(new Response('slow down', { status: 429 }));
    const res = await GET(req('https://solco.example/api/music/pool'));
    expect(res.status).toBe(429);
    expect(mocks.getRecordPool).not.toHaveBeenCalled();
  });
});
