// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  key: string;
  videoId: string | null;
  title: string | null;
  channelTitle: string | null;
  thumbnailUrl: string | null;
  createdAt: Date;
  expiresAt: Date;
};
const mocks = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  search: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: () => 'key' }));
vi.mock('@/lib/music/youtube-search.server', () => ({ searchYouTubeMusic: mocks.search }));
vi.mock('@/lib/music/youtube-search-store.server', () => ({
  storedYouTubeSearch: (_q: string, _n: number, load: () => Promise<unknown>) => load(),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    songResolution: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        mocks.rows.get(where.key) ?? null,
      upsert: async ({ where, create }: { where: { key: string }; create: Row }) => {
        mocks.rows.set(where.key, create);
        return create;
      },
      deleteMany: async () => ({ count: 0 }),
    },
  },
}));

import { NOT_FOUND_TTL_MS, resolveSong, songSearchQuery } from '@/lib/music/song-resolve.server';

const now = new Date('2026-11-11T12:00:00Z');
const official = {
  videoId: 'ccccccccccc',
  title: 'Strada Nuova',
  channelTitle: 'Band Finta - Topic',
  thumbnailUrl: 'https://i.ytimg.com/x.jpg',
};

beforeEach(() => {
  mocks.rows.clear();
  mocks.search.mockReset();
});

describe('brani importati: ricerca del video', () => {
  it('cerca "artista titolo" una volta e poi riusa il risultato', async () => {
    mocks.search.mockResolvedValue({ outcome: 'results', videos: [official] });
    expect(songSearchQuery('Strada Nuova - Remastered 2011', 'Band Finta, Altro')).toBe(
      'Band Finta Strada Nuova',
    );
    const first = await resolveSong('Strada Nuova', 'Band Finta', now);
    expect(first).toEqual({ ok: true, video: official });
    const again = await resolveSong('strada nuova', 'BAND FINTA', now);
    expect(again).toEqual({ ok: true, video: official });
    expect(mocks.search).toHaveBeenCalledOnce();
  });

  it('ricorda per un giorno un brano non trovato, e non salva gli errori di YouTube', async () => {
    mocks.search.mockResolvedValueOnce({ outcome: 'unavailable', videos: [] });
    expect(await resolveSong('Brano Raro', 'Nessuno', now)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(mocks.rows.size).toBe(0);

    mocks.search.mockResolvedValueOnce({ outcome: 'results', videos: [official] });
    expect(await resolveSong('Brano Raro', 'Nessuno', now)).toEqual({ ok: true, video: null });
    const row = [...mocks.rows.values()][0];
    expect(row?.expiresAt.getTime()).toBe(now.getTime() + NOT_FOUND_TTL_MS);
  });
});
