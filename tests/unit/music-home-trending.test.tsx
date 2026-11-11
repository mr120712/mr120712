// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicTrendingResponse } from '@/lib/contracts/music';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  player: {
    currentTrack: null as null | { qualifiedId: string },
    status: 'idle' as 'idle' | 'loading' | 'paused' | 'playing',
    togglePlayback: vi.fn(),
    playTrack: vi.fn(),
  },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({ useMusicPlayer: () => mocks.player }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { HomeTrending } from '@/components/custom/music/home-trending';

const response: MusicTrendingResponse = {
  outcome: 'results',
  tracks: [{
    provider: 'audius',
    id: 'track-71',
    qualifiedId: 'audius:track-71',
    title: 'Traccia di tendenza',
    artistName: 'Artista',
    artistHandle: 'artista',
    artistId: 'artist-71',
    artistQualifiedId: 'audius:artist-71',
    artistUrl: 'https://audius.co/artista',
    trackUrl: 'https://audius.co/artista/traccia',
    artworkUrl: 'https://audius.co/images/traccia.jpg',
    durationSeconds: 180,
    genre: null,
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
  }],
  albums: [],
  sourceStatus: {
    id: 'audius', label: 'Audius', active: true, searchOutcome: 'results',
    summary: 'Catalogo attivo.', prerequisite: 'Audius non configurata.',
  },
};
const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<HomeTrending />));
  await act(async () => { await Promise.resolve(); });
  return container;
}

beforeEach(() => {
  mocks.player.currentTrack = null;
  mocks.player.status = 'idle';
  mocks.player.playTrack.mockReset();
  mocks.player.togglePlayback.mockReset();
  mocks.apiFetch.mockReset().mockResolvedValue(response);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tendenze Audius', () => {
  it('riproduce i trend soltanto quando Audius conferma lo stream', async () => {
    const container = await mount();
    expect(container.textContent).toContain('Traccia di tendenza');
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === 'Riproduci',
    );
    if (!button) throw new Error('Controllo di riproduzione delle tendenze non trovato.');
    await act(async () => button.click());
    expect(mocks.player.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ playbackMode: 'audius' }),
      '/api/music/audius/tracks/track-71/stream',
      [expect.objectContaining({ qualifiedId: 'audius:track-71' })],
    );
  });
});
