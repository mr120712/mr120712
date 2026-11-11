// @polsia:user-owned

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicHomeResponse, MusicSearchSource } from '@/lib/contracts/music';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  player: {
    currentTrack: null as null | {
      qualifiedId: string;
      title: string;
      artistName: string;
      artistUrl: string;
      artworkUrl: string;
      sourceLabel: string;
      sourceUrl: string;
      playbackMode: 'audius' | 'solco';
    },
    status: 'idle' as 'idle' | 'paused' | 'playing',
    togglePlayback: vi.fn(),
    playTrack: vi.fn(),
  },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({ useMusicPlayer: () => mocks.player }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => (
    <span role="img" aria-label={alt}>
      {alt}
    </span>
  ),
}));

import { HomeCatalog } from '@/components/custom/music/home-catalog';

const source: MusicSearchSource = {
  id: 'audius',
  label: 'Audius',
  active: true,
  searchOutcome: 'results',
  summary: 'Catalogo Audius configurato.',
  prerequisite: 'Audius non è configurato.',
};

const track: MusicHomeResponse['trending']['tracks'][number] = {
  provider: 'audius',
  id: 'track-71',
  qualifiedId: 'audius:track-71',
  title: 'Traccia di prova',
  artistName: 'Artista di prova',
  artistHandle: 'artista-prova',
  artistId: 'artist-71',
  artistQualifiedId: 'audius:artist-71',
  artistUrl: 'https://audius.co/artista-prova',
  trackUrl: 'https://audius.co/artista-prova/traccia-di-prova',
  artworkUrl: 'https://audius.co/images/traccia.jpg',
  durationSeconds: 180,
  genre: 'Electronic',
  mood: null,
  tags: null,
  releaseDate: null,
  license: null,
  licensorName: null,
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
};

const populated: MusicHomeResponse = {
  sourceStatus: source,
  trending: { outcome: 'results', tracks: [track] },
  releases: {
    outcome: 'results',
    albums: [
      {
        provider: 'audius',
        id: 'album-71',
        qualifiedId: 'audius:album:album-71',
        title: 'Uscita di prova',
        artistName: 'Artista di prova',
        artistUrl: 'https://audius.co/artista-prova',
        albumUrl: 'https://audius.co/artista-prova/uscita',
        artworkUrl: 'https://audius.co/images/album.jpg',
        releaseDate: null,
        trackCount: 8,
      },
    ],
  },
  playlists: {
    outcome: 'results',
    playlists: [
      {
        provider: 'audius',
        id: 'playlist-71',
        qualifiedId: 'audius:playlist:playlist-71',
        title: 'Selezione di prova',
        artistName: 'Curatore di prova',
        artistUrl: 'https://audius.co/curatore',
        playlistUrl: 'https://audius.co/curatore/selezione',
        artworkUrl: 'https://audius.co/images/playlist.jpg',
        trackCount: 12,
      },
    ],
  },
  artists: {
    outcome: 'results',
    artists: [
      {
        provider: 'audius',
        id: 'artist-71',
        qualifiedId: 'audius:artist-71',
        name: 'Artista di prova',
        handle: 'artista-prova',
        artworkUrl: 'https://audius.co/images/artista.jpg',
        profileUrl: 'https://audius.co/artista-prova',
      },
    ],
  },
};

const empty: MusicHomeResponse = {
  sourceStatus: { ...source, searchOutcome: 'no_results' },
  trending: { outcome: 'no_results', tracks: [] },
  releases: { outcome: 'no_results', albums: [] },
  playlists: { outcome: 'no_results', playlists: [] },
  artists: { outcome: 'no_results', artists: [] },
};

const unavailable: MusicHomeResponse = {
  sourceStatus: {
    ...source,
    active: false,
    searchOutcome: 'unavailable',
    unavailableReason: 'not_configured',
    blockers: ['credential_missing'],
  },
  trending: { outcome: 'unavailable', tracks: [] },
  releases: { outcome: 'unavailable', albums: [] },
  playlists: { outcome: 'unavailable', playlists: [] },
  artists: { outcome: 'unavailable', artists: [] },
};

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<HomeCatalog />));
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.player.currentTrack = null;
  mocks.player.status = 'idle';
  mocks.player.playTrack.mockReset();
  mocks.player.togglePlayback.mockReset();
  mocks.apiFetch.mockReset().mockResolvedValue(populated);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('catalogo Audius nella Home', () => {
  it('mostra dati attribuiti nell’ordine richiesto, tutti i generi e la navigazione verso Cerca', async () => {
    const container = await mount();
    const sectionIds = ['tendenze', 'nuove-uscite', 'playlist', 'artisti', 'generi'];
    const renderedSectionIds = [...container.querySelectorAll<HTMLElement>('section[id]')].map(
      (section) => section.id,
    );
    expect(sectionIds.map((id) => renderedSectionIds.indexOf(id))).toEqual([0, 1, 2, 3, 4]);
    expect(container.textContent).toContain('Traccia di prova');
    expect(container.textContent).toContain('Uscita di prova');
    expect(container.textContent).toContain('Selezione di prova');
    expect(container.textContent).toContain('Artista di prova');
    expect(
      container.querySelector('a[href="https://audius.co/artista-prova/traccia-di-prova"]'),
    ).not.toBeNull();
    expect(container.querySelector('a[href="https://audius.co/artista-prova"]')).not.toBeNull();
    expect(container.querySelector('a[href="/search?q=Electronic"]')).not.toBeNull();

    const genres = [...container.querySelectorAll<HTMLAnchorElement>('#generi a')];
    expect(
      genres.map((item) => [item.querySelector('strong')?.textContent, item.getAttribute('href')]),
    ).toEqual([
      ['Electronic', '/search?q=Electronic'],
      ['Hip-Hop', '/search?q=Hip-Hop'],
      ['Rock', '/search?q=Rock'],
      ['Lo-fi', '/search?q=Lo-fi'],
      ['Pop', '/search?q=Pop'],
      ['Ambient', '/search?q=Ambient'],
    ]);
  });

  it('riproduce i trend eleggibili nel player condiviso con la coda e senza Pro', async () => {
    const container = await mount();
    const play = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Riproduci',
    );
    if (!play) throw new Error('Controllo di riproduzione delle tendenze non trovato.');

    await act(async () => play.click());

    expect(mocks.player.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        qualifiedId: 'audius:track-71',
        playbackMode: 'audius',
        sourceLabel: 'Solco · Audius',
      }),
      '/api/music/audius/tracks/track-71/stream',
      [expect.objectContaining({ qualifiedId: 'audius:track-71' })],
    );
  });

  it('distingue caricamento, catalogo senza risultati e credenziale mancante', async () => {
    let resolveResponse: ((value: MusicHomeResponse) => void) | undefined;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const container = await mount();
    expect(container.textContent).toContain('Caricamento le tendenze Audius…');

    await act(async () => resolveResponse?.(empty));
    expect(container.textContent).toContain('Audius non ha restituito le tendenze disponibili.');
    expect(container.textContent).toContain(
      'Audius non ha restituito le nuove uscite disponibili.',
    );
    expect(container.textContent).toContain('Audius non ha restituito le playlist disponibili.');
    expect(container.textContent).toContain('Audius non ha restituito gli artisti disponibili.');

    mocks.apiFetch.mockResolvedValueOnce(unavailable);
    const offline = await mount();
    expect(offline.textContent).toContain('AUDIUS_API_KEY');
    expect(offline.textContent).not.toContain('Traccia di prova');
  });

  it('mostra Riprendi soltanto quando il player contiene un brano Audius riprendibile', async () => {
    const idle = await mount();
    expect(idle.querySelector('#resume-title')).toBeNull();

    mocks.player.currentTrack = {
      qualifiedId: 'audius:track-71',
      title: 'Ripresa reale dal player',
      artistName: 'Artista di prova',
      artistUrl: 'https://audius.co/artista-prova',
      artworkUrl: 'https://audius.co/images/traccia.jpg',
      sourceLabel: 'Solco · Audius',
      sourceUrl: 'https://audius.co/artista-prova/traccia',
      playbackMode: 'audius',
    };
    mocks.player.status = 'paused';
    const paused = await mount();
    expect(paused.querySelector('#resume-title')?.textContent).toBe('Riprendi');
    expect(paused.textContent).toContain('Ripresa reale dal player');
  });
});
