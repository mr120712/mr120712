// @polsia:user-owned — «Cancella cronologia» cancella anche i consigli preparati da quella cronologia
// («Potrebbe piacerti»): i motivi non nominano più gli artisti appena cancellati e i suggerimenti AI
// tratti da quegli ascolti non vengono riportati. Solo la riga di quell'utente; un errore della cache
// non blocca la cancellazione della cronologia.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  historyDelete: vi.fn(),
  fetchDelete: vi.fn(),
  cacheDelete: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    userPlaybackHistory: { deleteMany: mocks.historyDelete },
    youTubeHistoryFetch: { deleteMany: mocks.fetchDelete },
    recommendationCache: { deleteMany: mocks.cacheDelete },
  },
}));

import { applyLibraryMutation } from '@/lib/music/library.server';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.historyDelete.mockImplementation(async () => {
    mocks.calls.push('history');
    return { count: 3 };
  });
  mocks.fetchDelete.mockImplementation(async () => {
    mocks.calls.push('youtube-dates');
    return { count: 1 };
  });
  mocks.cacheDelete.mockImplementation(async () => {
    mocks.calls.push('recommendations');
    return { count: 1 };
  });
});

describe('«Cancella cronologia» e «Potrebbe piacerti»', () => {
  it('cancella anche la cache dei consigli di quell’utente, dopo la cronologia', async () => {
    await applyLibraryMutation('user-1', { action: 'clear_history' });
    expect(mocks.cacheDelete).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(mocks.calls).toEqual(['history', 'youtube-dates', 'recommendations']);
  });

  it('errore della cache dei consigli: la cronologia è cancellata lo stesso, nessun errore', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.cacheDelete.mockRejectedValueOnce(new Error('db down'));
    await expect(
      applyLibraryMutation('user-1', { action: 'clear_history' }),
    ).resolves.toBeUndefined();
    expect(mocks.historyDelete).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});
