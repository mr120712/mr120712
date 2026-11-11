// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('@/components/custom/music/youtube-queue-player', () => ({
  loadYouTubeIframeApi: () => new Promise(() => undefined),
}));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const song: MusicPlayerTrack = {
  qualifiedId: `song:${'a'.repeat(32)}`,
  title: 'Strada Nuova',
  artistName: 'Band Finta',
  sourceLabel: 'YouTube',
  sourceUrl: null,
  playbackMode: 'song',
};
const roots: Array<ReturnType<typeof createRoot>> = [];

function Probe() {
  const player = useMusicPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() => void player.playTrack(song, trackStreamPath(song) ?? '', [song])}
      >
        Avvia
      </button>
      <output data-testid="current">
        {player.currentTrack
          ? `${player.currentTrack.qualifiedId}|${player.currentTrack.importedFrom ?? ''}`
          : ''}
      </output>
      <output data-testid="error">{player.errorMessage ?? ''}</output>
    </>
  );
}

async function play(resolveBody: unknown, status = 200) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetchMock = vi.fn(async (url: string) =>
    String(url).startsWith('/api/music/resolve-song')
      ? new Response(JSON.stringify(resolveBody), { status })
      : new Response(JSON.stringify({ premium: false, signedIn: true, allowed: true }), {
          status: 200,
        }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe />
      </MusicPlayerProvider>,
    ),
  );
  await act(async () => {
    container.querySelector('button')?.click();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return { container, fetchMock };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('player: brani importati', () => {
  it('cerca il brano su YouTube e lo riproduce come video, ricordando da dove viene', async () => {
    const { container, fetchMock } = await play({
      video: {
        videoId: 'ccccccccccc',
        title: 'Strada Nuova',
        channelTitle: 'Band Finta - Topic',
        thumbnailUrl: null,
      },
    });
    const resolveCall = fetchMock.mock.calls.find(([url]) =>
      String(url).startsWith('/api/music/resolve-song'),
    );
    expect(String(resolveCall?.[0])).toContain('title=Strada+Nuova');
    expect(String(resolveCall?.[0])).toContain('artist=Band+Finta');
    expect(container.querySelector('[data-testid="current"]')?.textContent).toBe(
      `youtube:ccccccccccc|${song.qualifiedId}`,
    );
  });

  it('mostra un messaggio chiaro quando il brano non si trova', async () => {
    const { container } = await play({ video: null });
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe(
      'Non ho trovato “Strada Nuova” su YouTube.',
    );
  });
});
