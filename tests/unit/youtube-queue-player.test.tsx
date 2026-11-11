// @polsia:user-owned
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { YouTubeQueuePlayer } from '@/components/custom/music/youtube-queue-player';

type PlayerEvents = {
  onReady: () => void;
  onStateChange: (event: { data: number }) => void;
  onError: (event: { data: number }) => void;
};

type FakeInstance = {
  videoId: string;
  host: string;
  playerVars: Record<string, string | number>;
  events: PlayerEvents;
  loadVideoById: ReturnType<typeof vi.fn>;
  pauseVideo: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const items = [
  { videoId: 'aaaaaaaaaaa', title: 'Primo video', channelTitle: 'Canale uno' },
  { videoId: 'bbbbbbbbbbb', title: 'Secondo video', channelTitle: 'Canale due' },
];
const instances: FakeInstance[] = [];
const mountedRoots: Array<ReturnType<typeof createRoot>> = [];
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

class FakePlayer {
  loadVideoById = vi.fn();
  pauseVideo = vi.fn();
  destroy = vi.fn();

  constructor(
    _element: HTMLElement,
    options: {
      videoId: string;
      host: string;
      playerVars: Record<string, string | number>;
      events: PlayerEvents;
    },
  ) {
    instances.push({
      videoId: options.videoId,
      host: options.host,
      playerVars: options.playerVars,
      events: options.events,
      loadVideoById: this.loadVideoById,
      pauseVideo: this.pauseVideo,
      destroy: this.destroy,
    });
  }
}

async function mount(options: { initialIndex?: number; onPlaying?: () => void } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('YT', { Player: FakePlayer });
  const container = document.createElement('div');
  const root = createRoot(container);
  mountedRoots.push(root);
  function Harness() {
    const [index, setIndex] = useState<number | null>(options.initialIndex ?? 0);
    if (index === null) return <p>Player chiuso</p>;
    return (
      <YouTubeQueuePlayer
        items={items}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
        onPlaying={options.onPlaying}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await Promise.resolve();
  });
  const instance = instances[0];
  if (!instance) throw new Error('Player YouTube non creato.');
  await act(async () => instance.events.onReady());
  return { container, instance };
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => root.unmount());
  instances.splice(0);
  if (originalVisibilityState)
    Object.defineProperty(document, 'visibilityState', originalVisibilityState);
  else Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('coda di riproduzione YouTube', () => {
  it('crea il player ufficiale con controlli visibili sul video selezionato', async () => {
    const { container, instance } = await mount();
    expect(instance.videoId).toBe('aaaaaaaaaaa');
    expect(instance.host).toBe('https://www.youtube.com');
    expect(instance.playerVars.controls).toBe(1);
    expect(container.textContent).toContain('Coda YouTube · 1 di 2');
    expect(container.textContent).toContain('Primo video');
  });

  it('passa al video successivo quando quello corrente termina', async () => {
    const { container, instance } = await mount();
    await act(async () => instance.events.onStateChange({ data: 0 }));
    expect(instance.loadVideoById).toHaveBeenCalledWith('bbbbbbbbbbb');
    expect(container.textContent).toContain('Coda YouTube · 2 di 2');

    await act(async () => instance.events.onStateChange({ data: 0 }));
    expect(instance.loadVideoById).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Coda YouTube terminata.');
  });

  it('salta i video non incorporabili senza uscire dalla coda', async () => {
    const { container, instance } = await mount();
    await act(async () => instance.events.onError({ data: 150 }));
    expect(instance.loadVideoById).toHaveBeenCalledWith('bbbbbbbbbbb');
    expect(container.textContent).toContain('Primo video');
    expect(container.textContent).toContain('Coda YouTube · 2 di 2');
  });

  it('avvisa la pagina quando parte la riproduzione e mette in pausa in background', async () => {
    const onPlaying = vi.fn();
    const { instance } = await mount({ onPlaying });
    await act(async () => instance.events.onStateChange({ data: 1 }));
    expect(onPlaying).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(instance.pauseVideo).toHaveBeenCalledTimes(1);
  });

  it('distrugge il player alla chiusura', async () => {
    const { container, instance } = await mount();
    const close = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      item.textContent?.includes('Chiudi player'),
    );
    if (!close) throw new Error('Controllo di chiusura non trovato.');
    await act(async () => close.click());
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Player chiuso');
  });
});
