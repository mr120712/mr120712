// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  limited: vi.fn(async () => null as Response | null),
  peek: vi.fn(),
  search: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: async () => mocks.user }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.limited,
  getRateLimitIdentity: (id: string) => `user:${id}`,
}));
vi.mock('@/lib/music/song-resolve.server', () => ({
  peekSongResolution: mocks.peek,
  searchSong: mocks.search,
  invalidateSongResolution: mocks.invalidate,
}));

import { GET, POST } from '@/app/api/music/resolve-song/route';

const video = {
  videoId: 'ccccccccccc',
  title: 'Strada Nuova',
  channelTitle: 'Band Finta',
  thumbnailUrl: null,
};
const get = () =>
  GET(
    new Request(
      'https://solco.test/api/music/resolve-song?title=Strada%20Nuova&artist=Band%20Finta',
    ),
  );

beforeEach(() => {
  mocks.user = { id: 'u1' };
  mocks.limited.mockReset().mockResolvedValue(null);
  mocks.peek.mockReset().mockResolvedValue(null);
  mocks.search.mockReset().mockResolvedValue({ ok: true, video });
  mocks.invalidate.mockReset();
});

describe('route /api/music/resolve-song', () => {
  it('un brano già noto non consuma limiti né quota', async () => {
    mocks.peek.mockResolvedValueOnce({ ok: true, video });
    const response = await get();
    expect(await response.json()).toEqual({ video });
    expect(mocks.limited).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('una ricerca nuova passa dai limiti per utente e globali', async () => {
    await get();
    expect(mocks.limited).toHaveBeenCalledWith('music.resolve_song', 'user:u1');
    expect(mocks.limited).toHaveBeenCalledWith('music.resolve_song.global', 'global');
    mocks.limited.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    expect((await get()).status).toBe(429);
  });

  it('richiede l’accesso e invalida solo con dati validi', async () => {
    const post = (body: unknown) =>
      POST(
        new Request('https://solco.test/api/music/resolve-song', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    expect((await post({ title: 'Strada Nuova', videoId: 'bad' })).status).toBe(400);
    expect(
      (await post({ title: 'Strada Nuova', artist: 'Band Finta', videoId: 'ccccccccccc' })).status,
    ).toBe(200);
    expect(mocks.invalidate).toHaveBeenCalledWith('Strada Nuova', 'Band Finta', 'ccccccccccc');
    mocks.user = null;
    expect((await get()).status).toBe(401);
  });
});
