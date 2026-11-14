// @polsia:user-owned — regressione: al logout il player si ferma e si svuota (il muro di login
// lascia montato il player sulle rotte pubbliche, quindi deve fermarsi da sé quando cade la sessione).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/login' }));
vi.mock('@/components/custom/music/youtube-queue-player', () => ({
  loadYouTubeIframeApi: () => new Promise(() => undefined),
}));

// Sessione controllabile: parte loggata, poi diventa nulla (logout).
const auth = vi.hoisted(() => ({
  state: { data: { user: { id: 'u1' } }, isPending: false } as {
    data: { user: { id: string } } | null;
    isPending: boolean;
  },
}));
vi.mock('@/lib/auth-client', () => ({ useSession: () => auth.state }));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { PLAYER_STORAGE_KEY, STOP_PLAYER_EVENT } from '@/lib/music/player-session';

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
      <output data-testid="current">{player.currentTrack?.qualifiedId ?? ''}</output>
    </>
  );
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  auth.state = { data: { user: { id: 'u1' } }, isPending: false };
});

describe('player: logout', () => {
  it('ferma e svuota il player quando la sessione cade', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/music/resolve-song')
          ? new Response(
              JSON.stringify({
                video: {
                  videoId: 'ccccccccccc',
                  title: 'Strada Nuova',
                  channelTitle: 'Band Finta - Topic',
                  thumbnailUrl: null,
                },
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ premium: false, signedIn: true, allowed: true }), {
              status: 200,
            }),
      ),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    // Elemento nuovo a ogni render: con lo stesso riferimento React salterebbe la riconciliazione.
    const render = () =>
      root.render(
        <MusicPlayerProvider>
          <Probe />
        </MusicPlayerProvider>,
      );
    await act(async () => render());
    await act(async () => {
      container.querySelector('button')?.click();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    // Un brano è in riproduzione.
    expect(container.querySelector('[data-testid="current"]')?.textContent).toBe(
      'youtube:ccccccccccc',
    );

    // Logout: la sessione diventa nulla e il player viene ri-renderizzato.
    auth.state = { data: null, isPending: false };
    await act(async () => {
      render();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    // Il player si è svuotato: nessun brano corrente.
    expect(container.querySelector('[data-testid="current"]')?.textContent).toBe('');
  });

  it('"Esci" ferma subito il player, prima che la sessione cambi, e dimentica la coda', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/music/resolve-song')
          ? new Response(
              JSON.stringify({
                video: {
                  videoId: 'ddddddddddd',
                  title: 'Strada Nuova',
                  channelTitle: 'Band Finta - Topic',
                  thumbnailUrl: null,
                },
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ premium: false, signedIn: true, allowed: true }), {
              status: 200,
            }),
      ),
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
      container.querySelector('button')?.click();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="current"]')?.textContent).toBe(
      'youtube:ddddddddddd',
    );
    window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ owner: 'u1', queue: [] }));

    // La sessione è ancora valida: è il pulsante "Esci" a fermare il player.
    await act(async () => {
      window.dispatchEvent(new Event(STOP_PLAYER_EVENT));
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="current"]')?.textContent).toBe('');
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });
});
