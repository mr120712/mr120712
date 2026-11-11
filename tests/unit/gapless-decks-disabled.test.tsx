// @polsia:user-owned — interruttore GAPLESS_DECKS_ENABLED spento: un solo elemento <audio>, nessun
// precaricamento, cambio di src a fine brano come prima del doppio elemento.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('@/lib/music/audio-decks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/audio-decks')>()),
  GAPLESS_DECKS_ENABLED: false,
}));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const audiusA: MusicPlayerTrack = {
  qualifiedId: 'audius:track-a',
  title: 'Alba',
  artistName: 'Artista Uno',
  sourceLabel: 'Audius',
  sourceUrl: null,
  durationSeconds: 200,
  playbackMode: 'audius',
};
const audiusB: MusicPlayerTrack = { ...audiusA, qualifiedId: 'audius:track-b', title: 'Brezza' };

function Probe() {
  const player = useMusicPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void player.playTrack(audiusA, trackStreamPath(audiusA) ?? '', [audiusA, audiusB])
        }
      >
        Avvia
      </button>
      <button type="button" onClick={() => player.primeAudio()}>
        Prepara audio
      </button>
    </>
  );
}

const roots: Array<ReturnType<typeof createRoot>> = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function json(body: unknown) {
  return new Response(JSON.stringify(body));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).startsWith('/api/music/plays')
        ? json({ allowed: true, used: 4, limit: 40 })
        : json({ premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 }),
    ),
  );
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('doppio elemento spento', () => {
  it('un solo <audio>: niente precaricamento, a fine brano cambia src sullo stesso elemento', async () => {
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
    const decks = container.querySelectorAll('audio');
    expect(decks).toHaveLength(1);
    const audio = decks[0] as HTMLAudioElement;

    const load = vi.mocked(HTMLMediaElement.prototype.load);
    load.mockClear();
    act(() => {
      (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
    });
    expect(load.mock.contexts).toEqual([audio]);

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await flush();
    });
    expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-a/stream');

    Object.defineProperty(audio, 'duration', { configurable: true, value: 200 });
    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 185 });
    await act(async () => {
      audio.dispatchEvent(new Event('timeupdate'));
      await flush();
    });
    await act(flush);
    // Rights still prepared ahead, but no element loads the next stream early.
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/music/audius/tracks/track-b/playback',
      expect.anything(),
    );
    expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-a/stream');

    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    Object.defineProperty(audio, 'ended', { configurable: true, value: true });
    await act(async () => {
      audio.dispatchEvent(new Event('ended'));
      expect(play.mock.contexts).toEqual([audio]);
      await flush();
    });
    expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-b/stream');
    expect(container.textContent).toContain('Brezza');
  });
});
