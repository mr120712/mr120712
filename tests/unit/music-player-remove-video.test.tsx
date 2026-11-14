// @polsia:user-owned — player reale: "Rimuovi video" senza versione solo audio toglie il video e
// passa al brano successivo (o chiude il player). Mai audio di YouTube senza il suo video.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { videoToTrack } from '@/components/custom/music/live-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const first = videoToTrack({
  videoId: 'aaaaaaaaaaa',
  title: 'Primo Video',
  channelTitle: 'Canale',
  thumbnailUrl: null,
});
const second = videoToTrack({
  videoId: 'bbbbbbbbbbb',
  title: 'Secondo Video',
  channelTitle: 'Canale',
  thumbnailUrl: null,
});

const audioVersion: MusicPlayerTrack = {
  qualifiedId: 'audius:a1',
  title: 'Primo Video',
  artistName: 'Canale',
  sourceLabel: 'Audius',
  sourceUrl: null,
  playbackMode: 'audius',
};

const roots: Array<ReturnType<typeof createRoot>> = [];
const yt = {
  loadVideoById: vi.fn(),
  cueVideoById: vi.fn(),
  loadPlaylist: vi.fn(),
  cuePlaylist: vi.fn(),
  playVideoAt: vi.fn(),
  getPlaylist: vi.fn(() => []),
  getPlaylistIndex: vi.fn(() => 0),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  stopVideo: vi.fn(),
  seekTo: vi.fn(),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 200),
  setPlaybackRate: vi.fn(),
  destroy: vi.fn(),
};

function Probe({ queue }: { queue: MusicPlayerTrack[] }) {
  const player = useMusicPlayer();
  const [start] = queue;
  return (
    <>
      <button
        type="button"
        data-start
        onClick={() =>
          start ? void player.playTrack(start, trackStreamPath(start) ?? '', queue) : undefined
        }
      >
        Avvia
      </button>
      <output data-current>{player.currentTrack?.qualifiedId ?? ''}</output>
      <output data-queue>{player.queue.map((item) => item.qualifiedId).join(',')}</output>
      <button
        type="button"
        data-replace
        onClick={() =>
          void player.replaceCurrentTrack(audioVersion, '/api/music/audius/tracks/a1/stream')
        }
      >
        Sostituisci
      </button>
    </>
  );
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function startQueue(queue: MusicPlayerTrack[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe queue={queue} />
      </MusicPlayerProvider>,
    ),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[data-start]')?.click();
    await settle();
  });
  return container;
}

const current = (container: HTMLElement) =>
  container.querySelector('output[data-current]')?.textContent ?? '';

const removeButton = (title: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="Rimuovi video: ${title}"]`);

// Ogni test parte un minuto dopo il precedente: fuori dalla pausa anti doppio tocco di
// "Rimuovi video" (un tocco subito dopo una rimozione colpirebbe il video seguente).
let minutes = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  minutes += 1;
  vi.setSystemTime(Date.now() + 60_000 * minutes);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Nessun catalogo solo audio attivo (Audius/Jamendo): "Rimuovi video" toglie subito il video.
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
  vi.useRealTimers();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('player: "Rimuovi video"', () => {
  it('nella barra del video: toglie il video e passa al brano successivo', async () => {
    const container = await startQueue([first, second]);
    expect(current(container)).toBe(first.qualifiedId);
    const button = removeButton('Primo Video');
    expect(button?.textContent).toContain('Rimuovi video');
    await act(async () => {
      button?.click();
      await settle();
    });
    expect(current(container)).toBe(second.qualifiedId);
  });

  it('ultimo (o unico) video: il player si chiude, nessuna musica resta', async () => {
    const container = await startQueue([first]);
    await act(async () => {
      removeButton('Primo Video')?.click();
      await settle();
    });
    expect(current(container)).toBe('');
    expect(document.querySelector('[data-youtube-official-frame]')).toBeNull();
  });

  it('anche nel player a schermo intero', async () => {
    const container = await startQueue([first, second]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label^="Apri il player"]')?.click(),
    );
    const buttons = document.querySelectorAll('button[aria-label="Rimuovi video: Primo Video"]');
    // A schermo intero la barra del video non c'è: resta solo il pulsante del player.
    expect(buttons).toHaveLength(1);
    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
      await settle();
    });
    expect(current(container)).toBe(second.qualifiedId);
  });

  it('versione solo audio trovata: prende il posto del video, il resto della coda resta', async () => {
    const container = await startQueue([first, second]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-replace]')?.click();
      await settle();
    });
    expect(current(container)).toBe('audius:a1');
    expect(container.querySelector('output[data-queue]')?.textContent).toBe(
      `audius:a1,${second.qualifiedId}`,
    );
  });
});
