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
  fetchedAt: new Date('2026-11-11T12:00:00Z'),
  stale: false,
  apiKey: 'key',
  budget: vi.fn((load: unknown) => load),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: () => mocks.apiKey }));
vi.mock('@/lib/music/youtube-search.server', () => ({ searchYouTubeMusic: mocks.search }));
// The budget itself is tested in youtube-budget.test.ts: here it always lets the search through.
vi.mock('@/lib/music/youtube-budget.server', () => ({
  withYouTubeSearchBudget: mocks.budget,
}));
vi.mock('@/lib/music/youtube-search-store.server', () => ({
  storedYouTubeSearchWithTime: async (
    query: string,
    _n: number,
    load: (term: string, size: number) => Promise<{ outcome: string; unavailableReason?: string }>,
  ) => {
    const result = await load(query, 25);
    return {
      result,
      fetchedAt: mocks.fetchedAt,
      stale: mocks.stale,
      ...(result.outcome === 'unavailable' ? { blockedBy: result.unavailableReason } : {}),
    };
  },
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
      updateMany: async ({
        where,
        data,
      }: {
        where: { key: string; videoId: string };
        data: { expiresAt: Date };
      }) => {
        const row = mocks.rows.get(where.key);
        if (row && row.videoId === where.videoId) row.expiresAt = data.expiresAt;
        return { count: row ? 1 : 0 };
      },
    },
  },
}));

import {
  FOUND_TTL_MS,
  invalidateSongResolution,
  NOT_FOUND_ON_SAVED_TTL_MS,
  NOT_FOUND_TTL_MS,
  peekSongResolution,
  resolveSong,
  songResolutionKey,
  songSearchQuery,
} from '@/lib/music/song-resolve.server';

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
  mocks.fetchedAt = now;
  mocks.stale = false;
  mocks.apiKey = 'key';
  mocks.budget.mockClear();
});

describe('brani importati: ricerca del video', () => {
  it('cerca "artista titolo" una volta e poi riusa il risultato', async () => {
    mocks.search.mockResolvedValue({ outcome: 'results', videos: [official] });
    expect(songSearchQuery('Strada Nuova - Remastered 2011', 'Band Finta, Altro')).toBe(
      'band finta strada nuova',
    );
    // Punctuation and YouTube operators never reach the query or split the cache.
    expect(songSearchQuery('Strada "Nuova" |', 'Band | Finta')).toBe('band finta strada nuova');
    // A version asked for in the title is searched once, not twice.
    expect(songSearchQuery('Strada Nuova (cover)', 'Band Finta')).toBe(
      'band finta strada nuova cover',
    );
    expect(songResolutionKey('Strada Nuova!', 'Band Finta')).toBe(
      songResolutionKey('strada nuova', 'BAND FINTA'),
    );
    const first = await resolveSong('Strada Nuova', 'Band Finta', now);
    expect(first).toEqual({ ok: true, video: official });
    const again = await resolveSong('strada nuova', 'BAND FINTA', now);
    expect(again).toEqual({ ok: true, video: official });
    expect(mocks.search).toHaveBeenCalledOnce();
  });

  it('ricorda per una settimana un brano non trovato, e non salva gli errori di YouTube', async () => {
    mocks.search.mockResolvedValueOnce({
      outcome: 'unavailable',
      videos: [],
      unavailableReason: 'budget_exhausted',
    });
    expect(await resolveSong('Brano Raro', 'Nessuno', now)).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'budget_exhausted',
    });
    expect(mocks.rows.size).toBe(0);

    mocks.search.mockResolvedValueOnce({ outcome: 'results', videos: [official] });
    expect(await resolveSong('Brano Raro', 'Nessuno', now)).toEqual({ ok: true, video: null });
    const row = [...mocks.rows.values()][0];
    expect(NOT_FOUND_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(row?.expiresAt.getTime()).toBe(now.getTime() + NOT_FOUND_TTL_MS);
  });

  it('un "non trovato" deciso su una ricerca salvata vale solo un giorno', async () => {
    mocks.stale = true;
    mocks.search.mockResolvedValueOnce({ outcome: 'results', videos: [official] });
    expect(await resolveSong('Altro Brano', 'Nessuno', now)).toEqual({ ok: true, video: null });
    const row = [...mocks.rows.values()][0];
    expect(row?.expiresAt.getTime()).toBe(now.getTime() + NOT_FOUND_ON_SAVED_TTL_MS);
  });

  it('cerca su YouTube la forma canonica del brano', async () => {
    mocks.search.mockResolvedValue({ outcome: 'results', videos: [official] });
    await resolveSong('Strada Nuova', 'Band Finta', now);
    expect(mocks.search).toHaveBeenCalledWith('band finta strada nuova', 'key', fetch, 25);
  });
});

describe('brani importati: scadenza e video non validi', () => {
  it('i 28 giorni partono da quando YouTube ha inviato il dato', async () => {
    mocks.fetchedAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    mocks.search.mockResolvedValue({ outcome: 'results', videos: [official] });
    await resolveSong('Strada Nuova', 'Band Finta', now);
    const row = [...mocks.rows.values()][0];
    expect(row?.expiresAt.getTime()).toBe(mocks.fetchedAt.getTime() + FOUND_TTL_MS);
  });

  it('non usa dati YouTube di oltre 28 giorni, anche se la vecchia scadenza era più lunga', async () => {
    const day = 24 * 60 * 60 * 1000;
    // A row written with the previous 29-day expiry, 28 days after YouTube sent the data.
    mocks.rows.set(songResolutionKey('Strada Nuova', 'Band Finta'), {
      key: songResolutionKey('Strada Nuova', 'Band Finta'),
      ...official,
      createdAt: new Date(now.getTime() - FOUND_TTL_MS),
      expiresAt: new Date(now.getTime() + day),
    });
    expect(await peekSongResolution('Strada Nuova', 'Band Finta', now)).toBeNull();
    expect(FOUND_TTL_MS).toBe(28 * day);
  });

  it('senza chiave YouTube non prende posti dal budget delle ricerche', async () => {
    mocks.apiKey = '';
    expect(await resolveSong('Strada Nuova', 'Band Finta', now)).toEqual({
      ok: false,
      error: 'unavailable',
      reason: 'not_configured',
    });
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('dimentica un video che non si riproduce, solo se è ancora quello salvato', async () => {
    mocks.search.mockResolvedValue({ outcome: 'results', videos: [official] });
    await resolveSong('Strada Nuova', 'Band Finta', now);
    await invalidateSongResolution('Strada Nuova', 'Band Finta', 'zzzzzzzzzzz', now);
    expect(await peekSongResolution('Strada Nuova', 'Band Finta', now)).not.toBeNull();
    await invalidateSongResolution('Strada Nuova', 'Band Finta', 'ccccccccccc', now);
    expect(await peekSongResolution('Strada Nuova', 'Band Finta', now)).toBeNull();
  });
});
