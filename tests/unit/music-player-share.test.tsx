// @polsia:user-owned — "Condividi" nel player: per un brano Audius il link porta il suo id (au) e
// l'immagine allegata al menu del telefono è la scheda ?au=<id>; per un video YouTube nessun id e
// la scheda ?t=…&a=… dello stesso brano.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({ allowed: true })) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));

import { videoToTrack } from '@/components/custom/music/live-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:J7Xb000',
  title: 'Luci basse',
  artistName: 'Artista Audius',
  artworkUrl: null,
  sourceLabel: 'Audius',
  sourceUrl: null,
  durationSeconds: 201,
  playbackMode: 'audius',
};

const video = videoToTrack({
  videoId: 'dQw4w9WgXcQ',
  title: 'Artista Finto - Canzone Finta (Official Video)',
  channelTitle: 'Canale Finto',
  thumbnailUrl: null,
});

const roots: Array<ReturnType<typeof createRoot>> = [];
let fetchMock: ReturnType<typeof vi.fn>;

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

async function openShareMenu(track: MusicPlayerTrack) {
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
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Condividi ${track === audius ? 'Luci basse' : 'Canzone Finta'}"]`,
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** Il link condiviso, letto dal link di Telegram del menu. */
function sharedLink() {
  const telegram = [...document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')].find(
    (anchor) => anchor.href.startsWith('https://t.me/share/url'),
  );
  return new URL(telegram?.href ?? 'https://invalid.example').searchParams.get('url') ?? '';
}

/** I percorsi same-origin scaricati dal menu (l'immagine da allegare). */
function imageRequests() {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), window.location.origin))
    .filter((url) => url.pathname.startsWith('/search/anteprima'))
    .map((url) => `${url.pathname}${url.search}`);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/search/anteprima.jpg')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response(JSON.stringify({ premium: false, signedIn: true, allowed: true }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('YT', {
    Player: function Player() {
      return {
        loadVideoById: vi.fn(),
        cueVideoById: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 200),
        destroy: vi.fn(),
      };
    },
  });
  // Il menu di sistema esiste: l'immagine si prepara all'apertura del menu.
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Reflect.deleteProperty(navigator, 'share');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('player: "Condividi"', () => {
  it('brano Audius: link con au=<id> e scheda ?au=<id>', async () => {
    await openShareMenu(audius);
    const link = new URL(sharedLink());
    expect(link.pathname).toBe('/search');
    expect(link.searchParams.get('au')).toBe('J7Xb000');
    expect(link.searchParams.get('t')).toBe('Luci basse');
    expect(link.searchParams.has('img')).toBe(false);
    expect(imageRequests()).toEqual(['/search/anteprima.jpg?au=J7Xb000']);
  });

  it('video YouTube: nessun id Audius, scheda ?t=…&a=… dello stesso brano', async () => {
    await openShareMenu(video);
    const link = new URL(sharedLink());
    expect(link.searchParams.has('au')).toBe(false);
    expect(link.searchParams.get('t')).toBe('Canzone Finta');
    expect(link.searchParams.get('a')).toBe('Artista Finto');
    expect(imageRequests()).toEqual(['/search/anteprima.jpg?t=Canzone%20Finta&a=Artista%20Finto']);
  });
});
