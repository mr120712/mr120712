// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/audius-source.server', () => ({ getAudiusAlbumCatalogDetail: mocks.catalog }));

import { GET } from '@/app/api/music/albums/[albumId]/route';

const album = {
  provider: 'audius',
  id: 'album-71',
  qualifiedId: 'audius:album:album-71',
  title: 'Album reale dal catalogo',
  artistName: 'Artista catalogo',
  artistUrl: 'https://audius.co/artist',
  albumUrl: 'https://audius.co/artist/album',
  artworkUrl: 'https://audius.co/images/album.jpg',
  releaseDate: '2026-06-12',
  trackCount: 1,
};
const track = {
  provider: 'audius',
  id: 'track-71',
  qualifiedId: 'audius:track-71',
  title: 'Brano reale dal catalogo',
  artistName: 'Artista catalogo',
  artistHandle: 'artist',
  artistId: 'artist-71',
  artistQualifiedId: 'audius:artist-71',
  artistUrl: 'https://audius.co/artist',
  trackUrl: 'https://audius.co/artist/track',
  artworkUrl: 'https://audius.co/images/cover.jpg',
  durationSeconds: 183,
  genre: null,
  mood: null,
  tags: null,
  releaseDate: null,
  license: 'metadata only',
  licensorName: 'Artista catalogo',
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
};
const params = { params: Promise.resolve({ albumId: 'album-71' }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.catalog.mockResolvedValue({ state: 'available', album, tracks: [track] });
});

describe('API della pagina album Audius', () => {
  it('mostra e abilita un brano pubblico senza account Pro o verifica album aggiuntiva', async () => {
    const response = await GET(new Request('https://solco.test/api/music/albums/album-71'), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body).toMatchObject({
      album: { id: 'album-71', title: 'Album reale dal catalogo' },
      tracks: [{ id: 'track-71', albumId: 'album-71', fullAccess: 'available' }],
    });
  });

  it('non dichiara riproducibile un brano negato o non confermato da Audius', async () => {
    mocks.catalog.mockResolvedValueOnce({
      state: 'available',
      album,
      tracks: [{ ...track, playbackEligible: false, playbackReason: 'state_unknown' }],
    });
    const response = await GET(new Request('https://solco.test/api/music/albums/album-71'), params);

    expect((await response.json()).tracks[0].fullAccess).toBe('unavailable');
  });

  it('mostra album assente o catalogo non verificabile senza righe sostitutive', async () => {
    mocks.catalog.mockResolvedValueOnce({ state: 'not_found', reason: 'album_not_found' });
    const missing = await GET(new Request('https://solco.test/api/music/albums/missing'), params);
    expect(missing.status).toBe(404);

    mocks.catalog.mockResolvedValueOnce({ state: 'unavailable', reason: 'catalog_unavailable' });
    const unavailable = await GET(new Request('https://solco.test/api/music/albums/album-71'), params);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'catalog_unavailable' });
  });
});
