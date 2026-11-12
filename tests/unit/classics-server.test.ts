// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  activation: vi.fn(),
  moodTracks: vi.fn(),
}));

vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: mocks.activation,
  getAudiusMoodTracks: mocks.moodTracks,
}));

import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { clearClassicsCache, getClassicsDecade } from '@/lib/music/classics.server';

let counter = 0;
function track(over: Partial<AudiusTrackSearchResult> = {}): AudiusTrackSearchResult {
  counter += 1;
  const id = `t${counter}`;
  return {
    id,
    qualifiedId: `audius:${id}`,
    playbackEligible: true,
    ...over,
  } as AudiusTrackSearchResult;
}

beforeEach(() => {
  vi.resetAllMocks();
  clearClassicsCache();
  counter = 0;
  mocks.activation.mockReturnValue({ active: true, apiKey: 'k' });
});

describe('getClassicsDecade', () => {
  it('inattivo quando Audius non è attivo', async () => {
    mocks.activation.mockReturnValue({ active: false });
    const result = await getClassicsDecade('80s');
    expect(result.outcome).toBe('inactive');
    expect(result.decade).toBe('80s');
    expect(mocks.moodTracks).not.toHaveBeenCalled();
  });

  it('costruisce una playlist per definizione, con i soli brani riproducibili', async () => {
    mocks.moodTracks.mockResolvedValue({
      outcome: 'results',
      tracks: [track(), track({ playbackEligible: false }), track()],
    });
    const result = await getClassicsDecade('70s');
    expect(result.outcome).toBe('results');
    expect(result.label).toBe('Anni 70');
    // 3 definizioni di playlist per gli anni 70.
    expect(result.playlists).toHaveLength(3);
    for (const playlist of result.playlists) {
      expect(playlist.tracks.every((t) => t.playbackEligible)).toBe(true);
      expect(playlist.tracks.length).toBe(2);
    }
  });

  it('decennio sconosciuto → default (primo, Anni 60)', async () => {
    mocks.moodTracks.mockResolvedValue({ outcome: 'results', tracks: [track()] });
    const result = await getClassicsDecade('pippo');
    expect(result.decade).toBe('60s');
    expect(result.label).toBe('Anni 60');
  });

  it('no_results quando nessun brano è riproducibile', async () => {
    mocks.moodTracks.mockResolvedValue({
      outcome: 'results',
      tracks: [track({ playbackEligible: false })],
    });
    const result = await getClassicsDecade('90s');
    expect(result.outcome).toBe('no_results');
    expect(result.playlists).toEqual([]);
  });

  it('partial quando una playlist fallisce ma le altre hanno brani (non in cache)', async () => {
    mocks.moodTracks
      .mockResolvedValueOnce({ outcome: 'unavailable', tracks: [] })
      .mockResolvedValue({ outcome: 'results', tracks: [track()] });
    const result = await getClassicsDecade('80s');
    expect(result.outcome).toBe('partial');
    expect(result.playlists.length).toBeGreaterThan(0);
    // 'partial' non va in cache: una seconda chiamata ricalcola.
    mocks.moodTracks.mockReset();
    mocks.moodTracks.mockResolvedValue({ outcome: 'results', tracks: [track()] });
    const second = await getClassicsDecade('80s');
    expect(second.outcome).toBe('results');
  });

  it('unavailable quando tutte le chiamate falliscono senza brani', async () => {
    mocks.moodTracks.mockResolvedValue({ outcome: 'unavailable', tracks: [] });
    const result = await getClassicsDecade('80s');
    expect(result.outcome).toBe('unavailable');
  });

  it('non mette in cache un risultato non disponibile', async () => {
    mocks.moodTracks.mockResolvedValue({ outcome: 'unavailable', tracks: [] });
    await getClassicsDecade('80s');
    mocks.moodTracks.mockResolvedValue({ outcome: 'results', tracks: [track()] });
    const second = await getClassicsDecade('80s');
    expect(second.outcome).toBe('results');
  });
});
