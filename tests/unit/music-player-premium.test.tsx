// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/radio' }));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const station: MusicPlayerTrack = {
  qualifiedId: 'radio:station-1',
  title: 'Radio Prova',
  artistName: 'Italy',
  sourceLabel: 'Radio dal vivo',
  sourceUrl: null,
  playbackMode: 'radio',
};
const roots: Array<ReturnType<typeof createRoot>> = [];

function Probe() {
  const player = useMusicPlayer();
  return (
    <button
      type="button"
      onClick={() => void player.playTrack(station, '/api/music/radio/station-1/stream')}
    >
      Avvia
    </button>
  );
}

async function mount(premium: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ premium }), { status: 200 })),
  );
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
    await Promise.resolve();
  });
  await act(async () => {
    container.querySelector('button')?.click();
    await Promise.resolve();
  });
  return container;
}

function setTime(audio: HTMLAudioElement, seconds: number) {
  Object.defineProperty(audio, 'currentTime', { configurable: true, value: seconds });
  audio.dispatchEvent(new Event('timeupdate'));
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('player: free con anteprima, Premium completo e in background', () => {
  it('ferma gli utenti free a 30 secondi e mostra l’invito a Premium, anche in background', async () => {
    const container = await mount(false);
    const audio = container.querySelector('audio');
    if (!audio) throw new Error('audio mancante');
    expect(container.textContent).toContain('ANTEPRIMA 30s');

    // Free previews keep playing in the background too.
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    await act(async () => setTime(audio, 12));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();

    await act(async () => setTime(audio, 30.2));
    expect(container.textContent).toContain('Fine dell’anteprima di 30 secondi.');
    expect(container.querySelector('a[href="/piani"]')).not.toBeNull();
  });

  it('lascia suonare Premium oltre 30 secondi e in background', async () => {
    const container = await mount(true);
    const audio = container.querySelector('audio');
    if (!audio) throw new Error('audio mancante');
    expect(container.textContent).not.toContain('ANTEPRIMA 30s');
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => setTime(audio, 95));
    expect(pause).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Fine dell’anteprima');
  });
});
