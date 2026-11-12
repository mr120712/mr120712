// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getAudiusActivation: vi.fn(),
  runAudiusSearch: vi.fn(),
  createAudiusApiClient: vi.fn(() => ({ id: 'client' })),
  resolveAudiusDownload: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: mocks.getAudiusActivation,
  runAudiusSearch: mocks.runAudiusSearch,
}));
vi.mock('@/lib/music/audius-api.server', () => ({
  createAudiusApiClient: mocks.createAudiusApiClient,
}));
vi.mock('@/lib/music/offline-download.server', () => ({
  resolveAudiusDownload: mocks.resolveAudiusDownload,
}));
vi.mock('@/lib/db', () => ({
  prisma: { songDownloadResolution: { findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));

import {
  audiusMatchScore,
  resolveDownloadableAudiusTrack,
} from '@/lib/music/song-download-resolve.server';

function track(id: string, title: string, artistName: string, playbackEligible = true) {
  return { id, title, artistName, playbackEligible };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createAudiusApiClient.mockReturnValue({ id: 'client' });
  mocks.getAudiusActivation.mockReturnValue({ active: true, apiKey: 'k', blockers: [] });
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({});
});

describe('audiusMatchScore', () => {
  it('dà punteggio alto a titolo+artista uguali', () => {
    expect(
      audiusMatchScore(
        { title: 'Blinding Lights', artist: 'The Weeknd' },
        { title: 'Blinding Lights', artistName: 'The Weeknd' },
      ),
    ).toBeGreaterThan(0.9);
  });

  it('scarta un artista diverso', () => {
    expect(
      audiusMatchScore(
        { title: 'Blinding Lights', artist: 'The Weeknd' },
        { title: 'Blinding Lights', artistName: 'Qualcun Altro' },
      ),
    ).toBe(0);
  });

  it('scarta un titolo diverso', () => {
    expect(
      audiusMatchScore(
        { title: 'Blinding Lights', artist: 'The Weeknd' },
        { title: 'Save Your Tears', artistName: 'The Weeknd' },
      ),
    ).toBe(0);
  });

  it('ignora i suffissi di versione e "feat."', () => {
    expect(
      audiusMatchScore(
        { title: 'Starboy (feat. Daft Punk)', artist: 'The Weeknd' },
        { title: 'Starboy', artistName: 'The Weeknd' },
      ),
    ).toBeGreaterThan(0.8);
  });
});

describe('resolveDownloadableAudiusTrack', () => {
  const song = { title: 'Open Song', artist: 'Indie Artist' };

  it('usa la cache senza interrogare Audius', async () => {
    mocks.findUnique.mockResolvedValue({
      audiusTrackId: 'cached-1',
      expiresAt: new Date(Date.now() + 1000),
    });
    const r = await resolveDownloadableAudiusTrack(song.title, song.artist);
    expect(r).toEqual({ audiusTrackId: 'cached-1' });
    expect(mocks.runAudiusSearch).not.toHaveBeenCalled();
  });

  it('trova e memorizza una traccia Audius scaricabile', async () => {
    mocks.runAudiusSearch.mockResolvedValue({
      outcome: 'results',
      tracks: [track('a1', 'Open Song', 'Indie Artist')],
      artists: [],
    });
    mocks.resolveAudiusDownload.mockResolvedValue({ ok: true });
    const r = await resolveDownloadableAudiusTrack(song.title, song.artist);
    expect(r).toEqual({ audiusTrackId: 'a1' });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert.mock.calls[0]?.[0].create.audiusTrackId).toBe('a1');
  });

  it('memorizza "nessuna" quando nulla combacia', async () => {
    mocks.runAudiusSearch.mockResolvedValue({
      outcome: 'results',
      tracks: [track('x', 'Another Thing', 'Someone Else')],
      artists: [],
    });
    const r = await resolveDownloadableAudiusTrack(song.title, song.artist);
    expect(r).toEqual({ audiusTrackId: null });
    expect(mocks.resolveAudiusDownload).not.toHaveBeenCalled();
    expect(mocks.upsert.mock.calls[0]?.[0].create.audiusTrackId).toBeNull();
  });

  it('salta un match non scaricabile e prova il successivo', async () => {
    mocks.runAudiusSearch.mockResolvedValue({
      outcome: 'results',
      tracks: [track('a1', 'Open Song', 'Indie Artist'), track('a2', 'Open Song', 'Indie Artist')],
      artists: [],
    });
    mocks.resolveAudiusDownload
      .mockResolvedValueOnce({ ok: false, reason: 'not_downloadable' })
      .mockResolvedValueOnce({ ok: true });
    const r = await resolveDownloadableAudiusTrack(song.title, song.artist);
    expect(r).toEqual({ audiusTrackId: 'a2' });
    expect(mocks.resolveAudiusDownload).toHaveBeenCalledTimes(2);
  });

  it('non memorizza nulla se Audius è spento', async () => {
    mocks.getAudiusActivation.mockReturnValue({ active: false, apiKey: '', blockers: ['x'] });
    const r = await resolveDownloadableAudiusTrack(song.title, song.artist);
    expect(r).toEqual({ audiusTrackId: null });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('non memorizza nulla se la ricerca è temporaneamente non disponibile', async () => {
    mocks.runAudiusSearch.mockResolvedValue({ outcome: 'unavailable', tracks: [], artists: [] });
    const r = await resolveDownloadableAudiusTrack(song.title, song.artist);
    expect(r).toEqual({ audiusTrackId: null });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
