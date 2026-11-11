// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));

import { videoToTrack } from '@/components/custom/music/live-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const video = videoToTrack({
  videoId: 'dQw4w9WgXcQ',
  title: 'Artista Finto - Canzone Finta (Official Video)',
  channelTitle: 'Canale Finto',
  thumbnailUrl: null,
});

const roots: Array<ReturnType<typeof createRoot>> = [];
const yt = {
  loadVideoById: vi.fn(),
  cueVideoById: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  seekTo: vi.fn(),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 200),
  destroy: vi.fn(),
};

function Probe({ track }: { track: MusicPlayerTrack }) {
  const player = useMusicPlayer();
  return (
    <button
      type="button"
      data-start
      onClick={() => void player.playTrack(track, trackStreamPath(track) ?? '', [track])}
    >
      Avvia
    </button>
  );
}

async function openFullPlayer(track: MusicPlayerTrack) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe track={track} />
      </MusicPlayerProvider>,
    ),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[data-start]')?.click();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  const expand = document.querySelector<HTMLButtonElement>('button[aria-label^="Apri il player"]');
  expect(expand).not.toBeNull();
  await act(async () => expand?.click());
  return container;
}

function menuTrigger() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('Ascolta altrove'),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ premium: false, signedIn: true, allowed: true }), {
          status: 200,
        }),
    ),
  );
  vi.stubGlobal('YT', {
    Player: function Player() {
      return yt;
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('player: menu "Ascolta altrove"', () => {
  it('sostituisce i vecchi link e apre lo stesso video su YouTube Music', async () => {
    await openFullPlayer(video);
    expect(document.body.textContent).not.toContain('Cerca su SoundCloud');
    const trigger = menuTrigger();
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')];
    const hrefs = links.map((a) => a.href);
    expect(hrefs.some((h) => h.startsWith('https://music.youtube.com/watch?v=dQw4w9WgXcQ'))).toBe(
      true,
    );
    // The search links use the song parsed from the video title, not the channel name.
    const spotify = hrefs.find((h) => h.startsWith('https://open.spotify.com/search/'));
    expect(decodeURIComponent(spotify ?? '')).toContain('Artista Finto Canzone Finta');
    for (const a of links) {
      expect(a.target).toBe('_blank');
      expect(a.rel).toContain('noopener');
    }
  });

  it('non compare per la radio dal vivo', async () => {
    const radio = {
      qualifiedId: 'radio:abc',
      title: 'Radio Finta',
      artistName: 'Stazione',
      sourceLabel: 'Radio',
      sourceUrl: null,
      playbackMode: 'radio',
    } as MusicPlayerTrack;
    await openFullPlayer(radio);
    expect(menuTrigger()).toBeUndefined();
  });
});
