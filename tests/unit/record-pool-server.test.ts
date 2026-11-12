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
import { clearRecordPoolCache, getRecordPool } from '@/lib/music/record-pool.server';

function track(id: string, over: Partial<AudiusTrackSearchResult> = {}): AudiusTrackSearchResult {
  return {
    id,
    qualifiedId: `audius:${id}`,
    downloadable: true,
    playbackEligible: true,
    ...over,
  } as AudiusTrackSearchResult;
}

beforeEach(() => {
  vi.resetAllMocks();
  clearRecordPoolCache();
  mocks.activation.mockReturnValue({ active: true, apiKey: 'k' });
});

describe('getRecordPool', () => {
  it('inattivo quando la sorgente Audius non è attiva', async () => {
    mocks.activation.mockReturnValue({ active: false });
    const result = await getRecordPool(null);
    expect(result.outcome).toBe('inactive');
    expect(mocks.moodTracks).not.toHaveBeenCalled();
  });

  it('tiene solo i brani scaricabili e riproducibili', async () => {
    mocks.moodTracks.mockResolvedValue({
      outcome: 'results',
      tracks: [
        track('1', { downloadable: true, playbackEligible: true }),
        track('2', { downloadable: false, playbackEligible: true }),
        track('3', { downloadable: true, playbackEligible: false }),
        track('4', { downloadable: undefined, playbackEligible: true }),
      ],
    });
    const result = await getRecordPool(null);
    expect(result.outcome).toBe('results');
    expect(result.tracks.map((t) => t.id)).toEqual(['1']);
  });

  it('deduplica per id', async () => {
    mocks.moodTracks.mockResolvedValue({
      outcome: 'results',
      tracks: [track('7'), track('7'), track('8')],
    });
    const result = await getRecordPool(null);
    expect(result.tracks.map((t) => t.id)).toEqual(['7', '8']);
  });

  it('usa il genere Audius dallo slug', async () => {
    mocks.moodTracks.mockResolvedValue({ outcome: 'results', tracks: [track('9')] });
    const result = await getRecordPool('techno');
    expect(result.genre).toBe('techno');
    expect(mocks.moodTracks).toHaveBeenCalledWith(
      expect.objectContaining({ genres: ['Techno'], moods: [] }),
    );
  });

  it('slug sconosciuto → tutti i generi curati', async () => {
    mocks.moodTracks.mockResolvedValue({ outcome: 'results', tracks: [track('10')] });
    const result = await getRecordPool('non-esiste');
    expect(result.genre).toBeNull();
    const call = mocks.moodTracks.mock.calls[0]?.[0];
    expect(Array.isArray(call.genres)).toBe(true);
    expect(call.genres.length).toBeGreaterThan(1);
  });

  it('no_results quando nessun brano è scaricabile', async () => {
    mocks.moodTracks.mockResolvedValue({
      outcome: 'results',
      tracks: [track('11', { downloadable: false })],
    });
    const result = await getRecordPool(null);
    expect(result.outcome).toBe('no_results');
    expect(result.tracks).toEqual([]);
  });

  it('propaga unavailable senza metterlo in cache', async () => {
    mocks.moodTracks.mockResolvedValue({ outcome: 'unavailable', tracks: [] });
    const first = await getRecordPool(null);
    expect(first.outcome).toBe('unavailable');
    // Un errore non va in cache: una seconda chiamata riprova la sorgente.
    mocks.moodTracks.mockResolvedValue({ outcome: 'results', tracks: [track('12')] });
    const second = await getRecordPool(null);
    expect(second.outcome).toBe('results');
    expect(mocks.moodTracks).toHaveBeenCalledTimes(2);
  });
});
