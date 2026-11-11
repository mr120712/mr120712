// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ activation: vi.fn(), trending: vi.fn(), albums: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: mocks.activation,
  getAudiusTrending: mocks.trending,
  getAudiusAlbumReleases: mocks.albums,
}));

import { GET } from '@/app/api/music/trending/route';

const track = {
  provider: 'audius',
  id: 'track-71',
  qualifiedId: 'audius:track-71',
  title: 'Titolo ufficiale',
  artistName: 'Artista ufficiale',
  artistHandle: 'artista',
  artistId: 'artist-71',
  artistQualifiedId: 'audius:artist-71',
  artistUrl: 'https://audius.co/artista',
  trackUrl: 'https://audius.co/artista/titolo',
  artworkUrl: 'https://audius.co/images/cover.jpg',
  durationSeconds: 180,
  genre: null,
  mood: null,
  tags: null,
  releaseDate: null,
  license: null,
  licensorName: 'Artista ufficiale',
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.activation.mockReturnValue({
    active: true,
    blockers: [],
    apiKey: 'server-only-fixture-key',
  });
  mocks.trending.mockResolvedValue({ tracks: [track], outcome: 'results' });
  mocks.albums.mockResolvedValue({ albums: [], outcome: 'no_results' });
});

describe('tendenze Audius della home', () => {
  it('restituisce i brani ufficiali completi senza divulgare la chiave server-side', async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      outcome: 'results',
      tracks: [
        {
          title: 'Titolo ufficiale',
          artistName: 'Artista ufficiale',
          artworkUrl: track.artworkUrl,
        },
      ],
      sourceStatus: { id: 'audius', active: true },
    });
    expect(JSON.stringify(body)).not.toContain('server-only-fixture-key');
  });

  it('mostra la credenziale mancante senza contattare Audius o creare risultati', async () => {
    mocks.activation.mockReturnValueOnce({
      active: false,
      blockers: ['credential_missing'],
      apiKey: '',
    });
    const response = await GET();
    expect(await response.json()).toMatchObject({
      outcome: 'unavailable',
      tracks: [],
      sourceStatus: { active: false, unavailableReason: 'not_configured' },
    });
    expect(mocks.trending).not.toHaveBeenCalled();
  });

  it('mostra unavailable quando la REST API Audius restituisce errore', async () => {
    mocks.trending.mockRejectedValueOnce(new Error('Audius unavailable'));
    mocks.albums.mockRejectedValueOnce(new Error('Audius unavailable'));
    const response = await GET();
    expect(await response.json()).toMatchObject({ outcome: 'unavailable', tracks: [], albums: [] });
  });
});
