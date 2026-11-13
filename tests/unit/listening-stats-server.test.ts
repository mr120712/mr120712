// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { userPlaybackHistory: { findMany: mocks.findMany } },
}));

import { getListeningStats } from '@/lib/music/listening-stats.server';

function row(partial: {
  title: string;
  artistName: string;
  sourceLabel: string;
  durationSeconds: number | null;
  playCount: number;
  lastPlayedAt: string;
}) {
  return { ...partial, lastPlayedAt: new Date(partial.lastPlayedAt) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getListeningStats', () => {
  it('aggrega ascolti, minuti, artisti e fonti', async () => {
    mocks.findMany.mockResolvedValue([
      row({
        title: 'A',
        artistName: 'Queen',
        sourceLabel: 'Solco · Audius',
        durationSeconds: 180,
        playCount: 3,
        lastPlayedAt: '2026-03-01T10:00:00.000Z',
      }),
      row({
        title: 'B',
        artistName: 'Queen',
        sourceLabel: 'YouTube',
        durationSeconds: 240,
        playCount: 1,
        lastPlayedAt: '2026-02-01T10:00:00.000Z',
      }),
      row({
        title: 'C',
        artistName: 'Oasis',
        sourceLabel: 'Solco · Audius',
        durationSeconds: null,
        playCount: 2,
        lastPlayedAt: '2026-01-01T10:00:00.000Z',
      }),
    ]);
    const stats = await getListeningStats('u1');

    expect(stats.totalListens).toBe(6); // 3 + 1 + 2
    expect(stats.uniqueTracks).toBe(3);
    expect(stats.uniqueArtists).toBe(2);
    // minuti: (3*180 + 1*240) / 60 = (540 + 240)/60 = 13 ; C ha durata null → non conta
    expect(stats.estimatedMinutes).toBe(13);
    // Top artisti: Queen 4, Oasis 2
    expect(stats.topArtists).toEqual([
      { name: 'Queen', plays: 4 },
      { name: 'Oasis', plays: 2 },
    ]);
    // Fonti: Audius 5 (3+2), YouTube 1
    expect(stats.bySource).toEqual([
      { label: 'Solco · Audius', plays: 5 },
      { label: 'YouTube', plays: 1 },
    ]);
    // Recenti: ordine dato dalla query (già desc per lastPlayedAt)
    expect(stats.recent.map((r) => r.title)).toEqual(['A', 'B', 'C']);
    expect(stats.recent[0]?.lastPlayedAt).toBe('2026-03-01T10:00:00.000Z');
  });

  it('nessuno storico → tutto a zero, liste vuote', async () => {
    mocks.findMany.mockResolvedValue([]);
    const stats = await getListeningStats('u1');
    expect(stats).toMatchObject({
      totalListens: 0,
      uniqueTracks: 0,
      uniqueArtists: 0,
      estimatedMinutes: 0,
      topArtists: [],
      bySource: [],
      recent: [],
    });
  });

  it('interroga solo lo storico dell’utente, dal più recente', async () => {
    mocks.findMany.mockResolvedValue([]);
    await getListeningStats('user-42');
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-42' },
        orderBy: { lastPlayedAt: 'desc' },
      }),
    );
  });
});
