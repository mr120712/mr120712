// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));

import { videoToTrack } from '@/components/custom/music/live-tracks';
import {
  MusicPlayerProvider,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const videos = [
  { videoId: 'aaaaaaaaaaa', title: 'Primo video', channelTitle: 'Canale A', thumbnailUrl: null },
  { videoId: 'bbbbbbbbbbb', title: 'Secondo video', channelTitle: 'Canale B', thumbnailUrl: null },
].map(videoToTrack);

type Events = {
  onStateChange: (e: { data: number }) => void;
  onError: (e: { data: number }) => void;
};
const roots: Array<ReturnType<typeof createRoot>> = [];
let events: Events | null = null;
const yt = {
  loadVideoById: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  seekTo: vi.fn(),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 200),
  destroy: vi.fn(),
};

function Probe() {
  const player = useMusicPlayer();
  const first = videos[0];
  if (!first) return null;
  return (
    <button
      type="button"
      onClick={() => void player.playTrack(first, trackStreamPath(first) ?? '', videos)}
    >
      Avvia
    </button>
  );
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe />
      </MusicPlayerProvider>,
    ),
  );
  return container;
}

function byLabel(container: HTMLElement, label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`${label} non trovato`);
  return button;
}

beforeEach(() => {
  for (const fn of Object.values(yt)) fn.mockClear();
  events = null;
  vi.stubGlobal('YT', {
    Player: function Player(_el: HTMLElement, options: { events: Events }) {
      events = options.events;
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

describe('player YouTube personalizzato', () => {
  it('usa il player ufficiale con controlli Solco, passa al successivo e si ferma in background', async () => {
    const [first] = videos;
    if (!first) throw new Error('video mancante');
    expect(trackStreamPath(first)).toBe('/youtube/aaaaaaaaaaa');
    const container = await mount();
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-youtube-official-frame]')).not.toBeNull();
    expect(events).not.toBeNull();

    await act(async () => events?.onStateChange({ data: 1 }));
    await act(async () => byLabel(container, 'Metti in pausa Primo video').click());
    expect(yt.pauseVideo).toHaveBeenCalled();

    await act(async () => events?.onStateChange({ data: 2 }));
    await act(async () => byLabel(container, 'Riproduci Primo video').click());
    expect(yt.playVideo).toHaveBeenCalled();

    await act(async () => events?.onStateChange({ data: 0 }));
    expect(yt.loadVideoById).toHaveBeenCalledWith('bbbbbbbbbbb');
    expect(container.textContent).toContain('Secondo video');

    yt.pauseVideo.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(yt.pauseVideo).toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('il pulsante X sopra il video chiude il player e distrugge il player YouTube', async () => {
    const container = await mount();
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const close = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Chiudi il video e ferma il player"]',
    );
    expect(close).not.toBeNull();
    // The bar sits above the official player, never on top of it.
    expect(close?.closest('[class*="videoBar"]')?.nextElementSibling?.className).toMatch(
      /videoHost/,
    );
    await act(async () => close?.click());
    expect(yt.destroy).toHaveBeenCalled();
    expect(container.querySelector('[data-youtube-official-frame]')).toBeNull();
    expect(container.querySelector('aside[aria-label="Player musicale Solco"]')).toBeNull();
  });

  it('salta i video non incorporabili', async () => {
    const container = await mount();
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => events?.onError({ data: 150 }));
    expect(yt.loadVideoById).toHaveBeenCalledWith('bbbbbbbbbbb');
  });
});
