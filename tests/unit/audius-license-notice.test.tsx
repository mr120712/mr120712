// @polsia:user-owned — OML §1.5 nelle liste Audius: avviso di licenza, copyright e link al brano.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudiusTrackSearchResult, MusicTrendingResponse } from '@/lib/contracts/music';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  player: {
    currentTrack: null as null | { qualifiedId: string },
    status: 'idle' as 'idle' | 'loading' | 'paused' | 'playing',
    errorMessage: null,
    togglePlayback: vi.fn(),
    playTrack: vi.fn(),
  },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => mocks.player,
  trackStreamPath: () => null,
}));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/albums/album-71' }));

import { AlbumDetail } from '@/components/custom/music/album-detail';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { HomeTrending } from '@/components/custom/music/home-trending';
import { MusicCollections } from '@/components/custom/music/music-collections';
import { MusicSearch } from '@/components/custom/music/music-search';

const OML_URL = 'https://openaudiofoundation.org/open-music-license.pdf';
const BLOCKED_TEXT =
  "L'artista ha scelto una licenza diversa: questo brano si ascolta solo su Audius.";

function track(overrides: Partial<AudiusTrackSearchResult> = {}): AudiusTrackSearchResult {
  return {
    provider: 'audius',
    id: 'track-71',
    qualifiedId: 'audius:track-71',
    title: 'Brano OML',
    artistName: 'Artista',
    artistHandle: 'artista',
    artistId: 'artist-71',
    artistQualifiedId: 'audius:artist-71',
    artistUrl: 'https://audius.co/artista',
    trackUrl: 'https://audius.co/artista/brano-oml',
    artworkUrl: 'https://audius.co/images/cover.jpg',
    durationSeconds: 180,
    genre: null,
    mood: null,
    tags: null,
    releaseDate: null,
    license: null,
    licensorName: 'Artista',
    copyrightNotice: '© 2025 Artista',
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible: true,
    playbackReason: 'ready',
    ...overrides,
  };
}

const blocked = track({
  id: 'track-72',
  qualifiedId: 'audius:track-72',
  title: 'Brano riservato',
  trackUrl: 'https://audius.co/artista/brano-riservato',
  license: 'All rights reserved',
  playbackEligible: false,
  playbackReason: 'license_not_allowed',
});

const roots: Array<ReturnType<typeof createRoot>> = [];

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

const omlLinks = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLAnchorElement>(`a[href="${OML_URL}"]`),
];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.player.playTrack.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('avviso Audius Open Music License', () => {
  it('cita la OML con un link accessibile in una nuova scheda, insieme al copyright', async () => {
    const container = await render(<AudiusLicenseNotice track={track()} showTrackLink />);
    const [link] = omlLinks(container);

    expect(container.textContent).toContain('© 2025 Artista');
    expect(container.textContent).toContain('Licenza: Audius Open Music License');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
    expect(link?.textContent).toContain('(si apre in una nuova scheda)');
    expect(container.querySelector('a[href="https://audius.co/artista/brano-oml"]')).not.toBeNull();
  });

  it('nasconde il copyright se l’artista ha chiesto di rimuovere l’attribuzione', async () => {
    const container = await render(
      <AudiusLicenseNotice track={track({ attributionRemovalRequested: true })} />,
    );
    expect(container.textContent).not.toContain('Artista');
    expect(omlLinks(container)).toHaveLength(1);
  });

  it('senza copyright_line di Audius mostra "© <licenziante>" (OML §1.5(b))', async () => {
    const container = await render(
      <AudiusLicenseNotice track={track({ copyrightNotice: null })} />,
    );
    expect(container.textContent).toContain('© Artista · Licenza: Audius Open Music License');

    const removed = await render(
      <AudiusLicenseNotice
        track={track({ copyrightNotice: null, attributionRemovalRequested: true })}
      />,
    );
    expect(removed.textContent).not.toContain('©');
    expect(omlLinks(removed)).toHaveLength(1);
  });

  it('non compare per i brani con una licenza alternativa', async () => {
    const container = await render(<AudiusLicenseNotice track={blocked} />);
    expect(container.textContent).toBe('');
  });
});

describe('liste Audius', () => {
  it('le tendenze mostrano l’avviso OML e spiegano i brani con licenza diversa', async () => {
    const response: MusicTrendingResponse = {
      outcome: 'results',
      tracks: [track(), blocked],
      albums: [],
      sourceStatus: {
        id: 'audius',
        label: 'Audius',
        active: true,
        searchOutcome: 'results',
        summary: 'Catalogo attivo.',
        prerequisite: 'Audius non configurata.',
      },
    };
    mocks.apiFetch.mockResolvedValue(response);
    const container = await render(<HomeTrending />);
    const [omlRow, blockedRow] = [...container.querySelectorAll('li')];

    expect(omlLinks(omlRow as HTMLElement)).toHaveLength(1);
    expect(blockedRow?.textContent).toContain(BLOCKED_TEXT);
    expect(blockedRow?.querySelector('button')).toBeNull();
    expect(
      blockedRow?.querySelector('a[href="https://audius.co/artista/brano-riservato"]'),
    ).not.toBeNull();
    expect(omlLinks(blockedRow as HTMLElement)).toHaveLength(0);
  });

  it('la tracklist dell’album rimanda ad Audius i brani con licenza diversa', async () => {
    mocks.apiFetch.mockResolvedValue({
      album: {
        provider: 'audius',
        id: 'album-71',
        qualifiedId: 'audius:album:album-71',
        title: 'Album',
        artistName: 'Artista',
        artistUrl: 'https://audius.co/artista',
        albumUrl: 'https://audius.co/artista/album',
        artworkUrl: null,
        releaseDate: null,
        trackCount: 2,
      },
      tracks: [
        { ...track(), albumId: 'album-71', fullAccess: 'available' },
        { ...blocked, albumId: 'album-71', fullAccess: 'unavailable' },
      ],
    });
    const container = await render(<AlbumDetail albumId="album-71" />);
    const [omlRow, blockedRow] = [...container.querySelectorAll('li')];

    expect(omlLinks(omlRow as HTMLElement)).toHaveLength(1);
    expect(omlRow?.querySelector('a[href="https://audius.co/artista/brano-oml"]')).not.toBeNull();
    expect(blockedRow?.textContent).toContain(BLOCKED_TEXT);
    expect(blockedRow?.querySelector('button')).toBeNull();
    expect(
      blockedRow?.querySelector('a[href="https://audius.co/artista/brano-riservato"]'),
    ).not.toBeNull();
  });
});

describe('raccolte e ricerca', () => {
  it('le righe Audius delle raccolte mostrano copyright e avviso OML', async () => {
    mocks.apiFetch.mockResolvedValue({
      collections: [
        {
          id: 'favorites-1',
          name: 'Preferiti',
          kind: 'favorites',
          createdAt: '2026-11-10T00:00:00.000Z',
          items: [
            {
              id: 'item-71',
              source: 'audius',
              sourceId: 'track-71',
              title: 'Brano OML',
              creatorName: 'Artista',
              artworkUrl: 'https://audius.co/images/cover.jpg',
              sourceUrl: 'https://audius.co/artista/brano-oml',
              artistUrl: 'https://audius.co/artista',
              durationSeconds: 180,
              createdAt: '2026-11-10T00:00:00.000Z',
              expiresAt: null,
            },
          ],
        },
      ],
    });
    const container = await render(<MusicCollections embedded />);
    const row = container.querySelector('article');

    expect(omlLinks(row as HTMLElement)).toHaveLength(1);
    expect(row?.textContent).toContain('© Artista · Licenza: Audius Open Music License');
    expect(row?.querySelector('a[href="https://audius.co/artista/brano-oml"]')).not.toBeNull();
  });

  it('la ricerca non offre preferiti né playlist per i brani con licenza diversa', async () => {
    const source = {
      id: 'audius' as const,
      label: 'Solco',
      active: true,
      searchOutcome: 'results' as const,
      summary: 'Audius configurata.',
      prerequisite: 'Audius non configurata.',
    };
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/music/source-status') return { sources: [source] };
      if (path === '/api/music/collections') {
        return {
          collections: [
            {
              id: 'playlist-1',
              name: 'Mia playlist',
              kind: 'playlist',
              createdAt: '2026-11-10T00:00:00.000Z',
              items: [],
            },
          ],
        };
      }
      if (path.startsWith('/api/music/search')) {
        return {
          source: 'audius',
          outcome: 'results',
          tracks: [track({ copyrightNotice: null }), blocked],
          artists: [],
          playlists: [],
          albums: [],
          videos: [],
          sourceStatus: source,
        };
      }
      return null;
    });
    const container = await render(<MusicSearch />);
    const query = container.querySelector<HTMLInputElement>('#music-query');
    const form = container.querySelector<HTMLFormElement>('form');
    if (!query || !form) throw new Error('Controlli di ricerca mancanti.');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        query,
        'Brano',
      );
      query.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const [omlCard, blockedCard] = [...container.querySelectorAll('article')];
    const buttons = (card: Element | undefined) =>
      [...(card?.querySelectorAll('button') ?? [])].map((button) => button.textContent);

    expect(omlCard?.textContent).toContain('© Artista');
    expect(buttons(omlCard)).toEqual(
      expect.arrayContaining([
        'Salva nei preferiti',
        'Riproduci su Solco',
        'Aggiungi alla playlist',
      ]),
    );
    expect(blockedCard?.textContent).toContain(BLOCKED_TEXT);
    expect(blockedCard?.textContent).not.toContain('Nessun audio parte');
    expect(buttons(blockedCard)).toEqual([]);
    expect(
      blockedCard?.querySelector('a[href="https://audius.co/artista/brano-riservato"]'),
    ).not.toBeNull();
  });
});
