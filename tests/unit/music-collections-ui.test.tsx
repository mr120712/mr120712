// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { MusicCollections } from '@/components/custom/music/music-collections';
import { MusicPlayerProvider } from '@/components/custom/music/music-player';

const collections = [
  {
    id: 'playlist-1',
    name: 'Brani misti',
    kind: 'playlist' as const,
    createdAt: '2026-11-10T00:00:00.000Z',
    items: [
      {
        id: 'item-audius',
        source: 'audius' as const,
        sourceId: 'track-71',
        title: 'Brano Audius',
        creatorName: 'Artista Audius',
        artworkUrl: 'https://audius.co/images/cover.jpg',
        sourceUrl: 'https://audius.co/artista/brano',
        artistUrl: 'https://audius.co/artista',
        durationSeconds: 180,
        createdAt: '2026-11-10T00:00:00.000Z',
        expiresAt: null,
      },
      {
        id: 'item-youtube',
        source: 'youtube' as const,
        sourceId: 'dQw4w9WgXcQ',
        title: 'Video YouTube',
        creatorName: 'Canale YouTube',
        artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
        sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        artistUrl: null,
        durationSeconds: null,
        createdAt: '2026-11-10T00:00:00.000Z',
        expiresAt: null,
      },
      {
        id: 'item-incomplete',
        source: 'audius' as const,
        sourceId: 'track-72',
        title: 'Brano incompleto',
        creatorName: 'Artista incompleto',
        artworkUrl: null,
        sourceUrl: null,
        artistUrl: null,
        durationSeconds: null,
        createdAt: '2026-11-10T00:00:00.000Z',
        expiresAt: null,
      },
    ],
  },
];

const roots: Array<ReturnType<typeof createRoot>> = [];

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <MusicCollections />
      </MusicPlayerProvider>,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  mocks.apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/music/collections') return { collections };
    if (path === '/api/music/audius/tracks/track-71/playback') return { allowed: true };
    return null;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('raccolte musicali per account', () => {
  it('riproduce i brani Audius e i video YouTube nel player Solco con il player ufficiale visibile', async () => {
    const container = await mount();
    expect(container.textContent).toContain('Brano Audius');
    expect(container.querySelector('a[href="https://audius.co/artista"]')?.textContent).toContain(
      'Profilo artista Audius',
    );
    expect(container.textContent).toContain('Brano incompleto');
    const audiusPlay = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Riproduci su Solco',
    );
    if (!audiusPlay) throw new Error('Controllo di riproduzione Audius non trovato.');
    await act(async () => {
      audiusPlay.click();
      await Promise.resolve();
    });
    expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toContain(
      '/api/music/audius/tracks/track-71/playback',
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/track-71/stream',
    );
    expect(container.textContent).not.toContain('Solco Pro');

    // YouTube items now play in the global Solco player, inside the official (visible) YouTube player.
    const ytPlayer = {
      loadVideoById: vi.fn(),
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      seekTo: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 0),
      destroy: vi.fn(),
    };
    const created: Array<{ videoId: string; playerVars: Record<string, unknown> }> = [];
    vi.stubGlobal('YT', {
      Player: function Player(
        _element: HTMLElement,
        options: { videoId: string; playerVars: Record<string, unknown> },
      ) {
        created.push(options);
        return ytPlayer;
      },
    });
    const youtubePlay = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Riproduci',
    );
    if (!youtubePlay) throw new Error('Controllo YouTube non trovato.');
    await act(async () => {
      youtubePlay.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-youtube-official-frame]')).not.toBeNull();
    expect(created[0]?.videoId).toBe('dQw4w9WgXcQ');
    expect(created[0]?.playerVars.controls).toBe(0);
  });
});
