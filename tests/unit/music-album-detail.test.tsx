// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/albums/album-71' }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { AlbumDetail } from '@/components/custom/music/album-detail';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';

const track = {
  provider: 'audius',
  id: 'track-71',
  qualifiedId: 'audius:track-71',
  albumId: 'album-71',
  title: 'Brano autorizzato',
  artistName: 'Artista Solco',
  artistHandle: 'artista',
  artistId: 'artist-71',
  artistQualifiedId: 'audius:artist-71',
  artistUrl: 'https://audius.co/artista',
  trackUrl: 'https://audius.co/artista/brano',
  artworkUrl: 'https://audius.co/images/cover.jpg',
  durationSeconds: 180,
  genre: null,
  mood: null,
  tags: null,
  releaseDate: null,
  license: 'catalogue metadata',
  licensorName: 'Artista Solco',
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
  fullAccess: 'rights_unverified',
};
const album = {
  provider: 'audius',
  id: 'album-71',
  qualifiedId: 'audius:album:album-71',
  title: 'Album Solco',
  artistName: 'Artista Solco',
  artistUrl: 'https://audius.co/artista',
  albumUrl: 'https://audius.co/artista/album',
  artworkUrl: null,
  releaseDate: '2026-06-12',
  trackCount: 1,
};
const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount(access: string) {
  mocks.apiFetch.mockImplementation(async (path: string) =>
    path === '/api/music/albums/album-71' ? { album, tracks: [{ ...track, fullAccess: access }] } : { allowed: true },
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(
    <MusicPlayerProvider><AlbumDetail albumId="album-71" /></MusicPlayerProvider>,
  ));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  mocks.apiFetch.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('stati di accesso nella pagina album', () => {
  it.each([
    ['pro_required', 'Richiede un accesso Audius non disponibile'],
    ['rights_unverified', 'Fonte o diritti Solco non verificati'],
    ['unavailable', 'Ascolto integrale non disponibile'],
  ])('mostra i metadati reali ma non il controllo per %s', async (access, label) => {
    const container = await mount(access);
    expect(container.textContent).toContain('Album Solco');
    expect(container.textContent).toContain('Brano autorizzato');
    expect(container.textContent).toContain(label);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
    expect(mocks.apiFetch.mock.calls.map(([path]) => path)).not.toContain(
      '/api/music/audius/tracks/track-71/playback',
    );
  });

  it('usa il percorso pubblico Audius per un brano confermato, senza Pro o album verificato', async () => {
    const container = await mount('available');
    const play = container.querySelector<HTMLButtonElement>('button');
    if (!play) throw new Error('Controllo autorizzato non trovato.');
    await act(async () => { play.click(); await Promise.resolve(); });
    expect(container.textContent).toContain('Audius conferma lo streaming pubblico');
    expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toContain(
      '/api/music/audius/tracks/track-71/playback',
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/track-71/stream',
    );
  });
});
