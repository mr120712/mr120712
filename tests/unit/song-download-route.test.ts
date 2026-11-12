// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  resolveDownloadableAudiusTrack: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));
vi.mock('@/lib/music/song-download-resolve.server', () => ({
  resolveDownloadableAudiusTrack: mocks.resolveDownloadableAudiusTrack,
}));

import { POST } from '@/app/api/music/import/downloadable-source/route';

const account = { id: 'user-1', email: 'u@solco.test' };

function post(body?: unknown) {
  return new Request('https://solco.example/api/music/import/downloadable-source', {
    method: 'POST',
    headers: { origin: 'https://solco.example', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validBody = {
  songs: [
    { id: 's1', title: 'A', artist: 'X' },
    { id: 's2', title: 'B', artist: 'Y' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue(account);
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('POST /api/music/import/downloadable-source', () => {
  it('rifiuta origin non valido', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await POST(post(validBody));
    expect(res.status).toBe(403);
  });

  it('richiede autenticazione', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('no', { status: 401 }));
    expect((await POST(post(validBody))).status).toBe(401);
  });

  it('applica il rate limit', async () => {
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const res = await POST(post(validBody));
    expect(res.status).toBe(429);
    expect(mocks.resolveDownloadableAudiusTrack).not.toHaveBeenCalled();
  });

  it('rifiuta un corpo non valido', async () => {
    expect((await POST(post({ songs: [] }))).status).toBe(400);
    expect((await POST(post({ nope: true }))).status).toBe(400);
  });

  it('risolve ogni brano e restituisce i risultati in ordine', async () => {
    mocks.resolveDownloadableAudiusTrack
      .mockResolvedValueOnce({ audiusTrackId: 'a1' })
      .mockResolvedValueOnce({ audiusTrackId: null });
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { id: 's1', audiusTrackId: 'a1' },
        { id: 's2', audiusTrackId: null },
      ],
    });
  });

  it('un errore del resolver per un brano non rompe il lotto', async () => {
    mocks.resolveDownloadableAudiusTrack
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ audiusTrackId: 'a2' });
    const res = await POST(post(validBody));
    expect(await res.json()).toEqual({
      results: [
        { id: 's1', audiusTrackId: null },
        { id: 's2', audiusTrackId: 'a2' },
      ],
    });
  });
});
