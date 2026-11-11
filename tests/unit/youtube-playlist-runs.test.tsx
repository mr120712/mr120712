// @polsia:user-owned — video YouTube consecutivi passati al player ufficiale come playlist: YouTube
// prepara e avvia il successivo, Solco segue l'indice senza ricaricare. Mai a pagina nascosta.
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn() }) }));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import {
  type YouTubeQueueItem,
  YouTubeQueuePlayer,
} from '@/components/custom/music/youtube-queue-player';

const NOTICE = 'Il video si è fermato perché sei uscito dall’app.';
const PLAYING = 1;
const ENDED = 0;
const PAUSED = 2;
const BUFFERING = 3;
const CUED = 5;

type Events = {
  onReady?: () => void;
  onStateChange: (event: { data: number }) => void;
  onError: (event: { data: number }) => void;
};

/** Official IFrame player stand-in: records every call and keeps a playlist position. */
class FakeYouTube {
  static instances: FakeYouTube[] = [];
  readonly options: { videoId: string; playerVars: Record<string, unknown>; events: Events };
  playlist: string[] | null = null;
  index = -1;
  videoId: string;

  constructor(
    _element: HTMLElement,
    options: { videoId: string; playerVars: Record<string, unknown>; events: Events },
  ) {
    this.options = options;
    this.videoId = options.videoId;
    FakeYouTube.instances.push(this);
  }

  private go(index: number) {
    if (!this.playlist || index < 0 || index >= this.playlist.length) return;
    this.index = index;
    this.videoId = this.playlist[index] ?? '';
  }

  loadVideoById = vi.fn((videoId: string) => {
    this.playlist = null;
    this.index = -1;
    this.videoId = videoId;
  });
  loadPlaylist = vi.fn((playlist: string[], index = 0, _startSeconds = 0) => {
    this.playlist = [...playlist];
    this.go(index);
  });
  cuePlaylist = vi.fn((playlist: string[], index = 0, _startSeconds = 0) => {
    this.playlist = [...playlist];
    this.go(index);
  });
  nextVideo = vi.fn(() => this.go(this.index + 1));
  previousVideo = vi.fn(() => this.go(this.index - 1));
  playVideoAt = vi.fn((index: number) => this.go(index));
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  seekTo = vi.fn();
  getCurrentTime = vi.fn(() => 0);
  getDuration = vi.fn(() => 200);
  getPlaylistIndex = vi.fn(() => this.index);
  getVideoData = vi.fn(() => ({ video_id: this.videoId }));
  destroy = vi.fn();

  /** What YouTube does by itself at the end of a playlist video: the next one. */
  autoAdvance() {
    this.go(this.index + 1);
  }

  async state(data: number) {
    await act(async () => this.options.events.onStateChange({ data }));
  }

  /** Calls that load or switch a video (never expected while YouTube follows its own playlist). */
  switches() {
    return (
      this.loadVideoById.mock.calls.length +
      this.loadPlaylist.mock.calls.length +
      this.nextVideo.mock.calls.length +
      this.previousVideo.mock.calls.length +
      this.playVideoAt.mock.calls.length
    );
  }
}

const id = (letter: string) => letter.repeat(11);
function video(letter: string, title: string): MusicPlayerTrack {
  return {
    qualifiedId: `youtube:${id(letter)}`,
    title,
    artistName: `Canale ${letter.toUpperCase()}`,
    sourceLabel: 'YouTube',
    sourceUrl: `https://www.youtube.com/watch?v=${id(letter)}`,
    playbackMode: 'youtube',
  };
}
const one = video('a', 'Video uno');
const two = video('b', 'Video due');
const three = video('c', 'Video tre');
const four = video('f', 'Video quattro');
const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:track-a',
  title: 'Alba',
  artistName: 'Artista Uno',
  sourceLabel: 'Audius',
  sourceUrl: 'https://audius.co/artistauno/alba',
  durationSeconds: 200,
  playbackMode: 'audius',
};
const song: MusicPlayerTrack = {
  qualifiedId: `song:${'d'.repeat(32)}`,
  title: 'Brano importato',
  artistName: 'Band',
  sourceLabel: 'YouTube',
  sourceUrl: null,
  playbackMode: 'song',
};
const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia sequenza': [one, two, three, audius],
  'Avvia con brano importato': [one, two, song, four],
  'Avvia solo video': [one, two, three],
};

const roots: Array<ReturnType<typeof createRoot>> = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let handlers: Map<string, ((details: MediaSessionActionDetails) => void) | null>;
let session: {
  metadata: { title?: string } | null;
  playbackState: string;
  setActionHandler: unknown;
};

function Probe() {
  const player = useMusicPlayer();
  return (
    <>
      {Object.entries(queues).map(([label, queue]) => {
        const first = queue[0] as MusicPlayerTrack;
        return (
          <button
            key={label}
            type="button"
            onClick={() => void player.playTrack(first, trackStreamPath(first) ?? '', queue)}
          >
            {label}
          </button>
        );
      })}
      <output data-testid="now">{`${player.queueIndex}|${player.currentTrack?.title ?? ''}`}</output>
      <output data-testid="status">{player.status}</output>
    </>
  );
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Pulsante ${label} non trovato.`);
  return found;
}

function now(container: HTMLElement) {
  return container.querySelector('[data-testid="now"]')?.textContent;
}

function status(container: HTMLElement) {
  return container.querySelector('[data-testid="status"]')?.textContent;
}

async function setHidden(hidden: boolean) {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: hidden ? 'hidden' : 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
  });
}

async function mountPlayer() {
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
  await act(flush);
  return container;
}

/** Starts a queue in the shared player and lets the official player become ready. */
async function startQueue(container: HTMLElement, label: string) {
  await act(async () => {
    button(container, label).click();
    await flush();
  });
  await act(flush);
  const player = FakeYouTube.instances.at(-1);
  if (!player) throw new Error('Player YouTube non creato.');
  await act(async () => player.options.events.onReady?.());
  return player;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  FakeYouTube.instances.splice(0);
  vi.stubGlobal('YT', { Player: FakeYouTube });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      const body = path.startsWith('/api/music/access')
        ? { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 }
        : path.startsWith('/api/music/plays')
          ? { allowed: true, used: 3, limit: 40 }
          : path.startsWith('/api/music/resolve-song')
            ? {
                video: {
                  videoId: id('e'),
                  title: 'Brano importato (video)',
                  channelTitle: 'Band - Topic',
                  thumbnailUrl: null,
                },
              }
            : path.includes('source-status')
              ? { sources: [{ id: 'audius', active: true }] }
              : {};
      return new Response(JSON.stringify(body));
    }),
  );
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  handlers = new Map();
  session = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn((action: string, handler: (d: MediaSessionActionDetails) => void) => {
      handlers.set(action, handler);
    }),
  };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Reflect.deleteProperty(navigator, 'mediaSession');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('player condiviso: sequenze di video YouTube come playlist', () => {
  it('carica la sequenza con loadPlaylist sul player esistente, indice del video scelto', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    expect(FakeYouTube.instances).toHaveLength(1);
    // The visible official player, created on the chosen video.
    expect(player.options.videoId).toBe(id('a'));
    expect(container.querySelector('[data-youtube-official-frame]')).not.toBeNull();
    // The Audius item after the third video ends the run.
    expect(player.loadPlaylist).toHaveBeenCalledTimes(1);
    expect(player.loadPlaylist).toHaveBeenCalledWith([id('a'), id('b'), id('c')], 0, 0);
    expect(player.loadVideoById).not.toHaveBeenCalled();
  });

  it('segue il video successivo avviato da YouTube senza ricaricare il player', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);
    expect(now(container)).toBe('0|Video uno');
    const loads = player.switches();

    await player.state(ENDED);
    // Not the last video of the run: YouTube goes on by itself, the queue does not.
    expect(now(container)).toBe('0|Video uno');
    player.autoAdvance();
    await player.state(PLAYING);

    expect(now(container)).toBe('1|Video due');
    expect(status(container)).toBe('playing');
    expect(player.switches()).toBe(loads);
    expect(FakeYouTube.instances).toHaveLength(1);
    // Lock screen / notification metadata and the player UI follow the video on screen.
    expect(session.metadata?.title).toBe('Video due');
    expect(
      container.querySelector('aside[aria-label="Player musicale Solco"]')?.textContent,
    ).toContain('Video due');
  });

  it('successivo, precedente, schermata di blocco e coda usano la playlist di YouTube', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);

    await act(async () => button(container, 'Brano successivo').click());
    expect(player.nextVideo).toHaveBeenCalledTimes(1);
    expect(now(container)).toBe('1|Video due');
    await player.state(PLAYING);
    expect(now(container)).toBe('1|Video due');

    await act(async () => button(container, 'Brano precedente').click());
    expect(player.previousVideo).toHaveBeenCalledTimes(1);
    expect(now(container)).toBe('0|Video uno');
    await player.state(PLAYING);

    // Media Session "next" (e.g. a keyboard media key while Solco is on screen).
    await act(async () => handlers.get('nexttrack')?.({ action: 'nexttrack' }));
    expect(player.nextVideo).toHaveBeenCalledTimes(2);
    expect(now(container)).toBe('1|Video due');
    await player.state(PLAYING);

    // A tap on another video of the queue.
    const queueButton = [
      ...container.querySelectorAll<HTMLButtonElement>('details li button'),
    ].find((item) => item.textContent?.includes('Video uno'));
    if (!queueButton) throw new Error('Elemento della coda non trovato.');
    await act(async () => queueButton.click());
    expect(player.previousVideo).toHaveBeenCalledTimes(2);
    await player.state(PLAYING);
    const third = [...container.querySelectorAll<HTMLButtonElement>('details li button')].find(
      (item) => item.textContent?.includes('Video tre'),
    );
    await act(async () => third?.click());
    expect(player.playVideoAt).toHaveBeenCalledWith(2);
    expect(now(container)).toBe('2|Video tre');

    // Never a reload of the run, never the old per-video load.
    expect(player.loadPlaylist).toHaveBeenCalledTimes(1);
    expect(player.loadVideoById).not.toHaveBeenCalled();
  });

  it('la fine dell’ultimo video della sequenza passa al brano Audius successivo', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);
    for (const expected of ['1|Video due', '2|Video tre']) {
      await player.state(ENDED);
      player.autoAdvance();
      await player.state(PLAYING);
      expect(now(container)).toBe(expected);
    }

    await act(async () => {
      player.options.events.onStateChange({ data: ENDED });
      await flush();
    });
    await act(flush);
    expect(now(container)).toBe('3|Alba');
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/track-a/stream',
    );
    expect(player.pauseVideo).toHaveBeenCalled();
    // The official player goes away with the last video of the queue.
    expect(player.destroy).toHaveBeenCalled();
    expect(container.querySelector('[data-youtube-official-frame]')).toBeNull();
  });

  it('un brano importato non ancora cercato interrompe la sequenza; risolto, ne fa parte', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia con brano importato');
    expect(player.loadPlaylist).toHaveBeenCalledWith([id('a'), id('b')], 0, 0);

    await player.state(PLAYING);
    await player.state(ENDED);
    player.autoAdvance();
    await player.state(PLAYING);
    expect(now(container)).toBe('1|Video due');

    // End of the run: the song is looked up on YouTube only now.
    await act(async () => {
      player.options.events.onStateChange({ data: ENDED });
      await flush();
    });
    await act(flush);
    expect(now(container)).toBe('2|Brano importato');
    // Resolved, it joins the videos around it in a new run, on the same player.
    expect(player.loadPlaylist).toHaveBeenCalledTimes(2);
    expect(player.loadPlaylist).toHaveBeenLastCalledWith(
      [id('a'), id('b'), id('e'), id('f')],
      2,
      0,
    );
    expect(FakeYouTube.instances).toHaveLength(1);
  });

  it('a pagina nascosta il video avviato da YouTube viene fermato subito e spiegato al ritorno', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);

    await setHidden(true);
    expect(player.pauseVideo).toHaveBeenCalled();
    // Suppose YouTube still reached the end and advanced while Solco was hidden.
    await player.state(ENDED);
    player.autoAdvance();
    player.pauseVideo.mockClear();
    await player.state(PLAYING);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(now(container)).toBe('1|Video due');
    expect(status(container)).toBe('paused');
    await player.state(PAUSED);

    await setHidden(false);
    const notice = container.querySelector<HTMLElement>('[data-background-switch-notice]');
    expect(notice?.textContent).toContain(NOTICE);
    expect(notice?.closest('[data-youtube-official-frame]')).not.toBeNull();
    expect(button(container, 'Continua in background con Audius')).toBeTruthy();
    // Resuming is the listener's choice: nothing started by itself.
    expect(player.playVideo).not.toHaveBeenCalled();
  });

  it('a pagina nascosta anche il video che YouTube sta caricando viene fermato', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);
    await setHidden(true);
    await player.state(ENDED);
    player.autoAdvance();
    player.pauseVideo.mockClear();
    await player.state(BUFFERING);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(now(container)).toBe('1|Video due');
    expect(status(container)).toBe('paused');
  });

  it('a pagina nascosta si ferma anche il video chiesto con “successivo” appena prima', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);
    await act(async () => button(container, 'Brano successivo').click());
    expect(player.nextVideo).toHaveBeenCalledTimes(1);

    // The screen locks while that video loads: its pause may be lost, so BUFFERING pauses again.
    await setHidden(true);
    player.pauseVideo.mockClear();
    await player.state(BUFFERING);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(now(container)).toBe('1|Video due');
    expect(status(container)).toBe('paused');
    await player.state(PAUSED);

    // It never played: no "video fermato" notice on return.
    await setHidden(false);
    expect(container.querySelector('[data-background-switch-notice]')).toBeNull();
    expect(player.playVideo).not.toHaveBeenCalled();
  });

  it('a pagina nascosta, BUFFERING e PLAYING nello stesso turno: avviso per il video seguito', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);
    await setHidden(true);
    await player.state(ENDED);
    player.autoAdvance();
    // No re-render between the two reports.
    await act(async () => {
      player.options.events.onStateChange({ data: BUFFERING });
      player.options.events.onStateChange({ data: PLAYING });
    });
    expect(now(container)).toBe('1|Video due');
    await player.state(PAUSED);

    await setHidden(false);
    const notice = container.querySelector<HTMLElement>('[data-background-switch-notice]');
    expect(notice?.textContent).toContain(NOTICE);
    expect(button(container, 'Continua in background con Audius')).toBeTruthy();
  });

  it('un video della sequenza preparato ma non avviato (CUED) lascia il tasto play attivo', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    await player.state(PLAYING);
    await player.state(ENDED);
    expect(status(container)).toBe('loading');
    player.autoAdvance();
    await player.state(CUED);

    expect(now(container)).toBe('1|Video due');
    expect(status(container)).toBe('paused');
    expect(button(container, 'Riproduci Video due').disabled).toBe(false);
    expect(player.switches()).toBe(1);
  });

  it('se la playlist di YouTube non è la sequenza, la fine del video fa avanzare la coda', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    // YouTube holds fewer videos than the run: it would never start the next one by itself.
    Object.assign(player, { getPlaylist: vi.fn(() => [id('a')]) });
    await player.state(PLAYING);

    await act(async () => {
      player.options.events.onStateChange({ data: ENDED });
      await flush();
    });
    await act(flush);
    expect(now(container)).toBe('1|Video due');
    // The run handed to YouTube again, now on the next video, on the same official player.
    expect(player.loadPlaylist).toHaveBeenCalledTimes(2);
    expect(player.loadPlaylist).toHaveBeenLastCalledWith([id('a'), id('b'), id('c')], 1, 0);
    expect(FakeYouTube.instances).toHaveLength(1);
  });

  it('se la playlist di YouTube è la sequenza, la fine del video aspetta YouTube', async () => {
    const container = await mountPlayer();
    const player = await startQueue(container, 'Avvia sequenza');
    Object.assign(player, { getPlaylist: vi.fn(() => [id('a'), id('b'), id('c')]) });
    await player.state(PLAYING);
    const loads = player.switches();
    await player.state(ENDED);
    expect(now(container)).toBe('0|Video uno');
    expect(player.switches()).toBe(loads);
  });

  it('“successivo” dalla schermata di blocco non avvia video: riparte al ritorno nella playlist', async () => {
    const container = await mountPlayer();
    // Only videos: with an Audius item later in the queue, a hidden "next" would pick that one.
    const player = await startQueue(container, 'Avvia solo video');
    await player.state(PLAYING);
    await setHidden(true);

    await act(async () => {
      handlers.get('nexttrack')?.({ action: 'nexttrack' });
      await flush();
    });
    expect(player.nextVideo).not.toHaveBeenCalled();
    expect(player.playVideoAt).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Il prossimo è un video YouTube');

    await setHidden(false);
    await act(flush);
    // Same playlist, no reload: a jump to the next video once Solco is visible again.
    expect(player.playVideoAt).toHaveBeenCalledWith(1);
    expect(player.loadPlaylist).toHaveBeenCalledTimes(1);
    expect(now(container)).toBe('1|Video due');
  });
});

describe('coda YouTube della ricerca: la coda è una playlist del player ufficiale', () => {
  const items: YouTubeQueueItem[] = [
    { videoId: id('a'), title: 'Primo video', channelTitle: 'Canale uno' },
    { videoId: id('b'), title: 'Secondo video', channelTitle: 'Canale due' },
    { videoId: id('c'), title: 'Terzo video', channelTitle: 'Canale tre' },
  ];

  async function mountQueue(onPlaying = vi.fn()) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const changes: number[] = [];
    function Harness() {
      const [index, setIndex] = useState<number | null>(0);
      if (index === null) return <p>Player chiuso</p>;
      return (
        <YouTubeQueuePlayer
          items={items}
          index={index}
          onIndexChange={(next) => {
            changes.push(next);
            setIndex(next);
          }}
          onClose={() => setIndex(null)}
          onPlaying={onPlaying}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    await act(flush);
    const player = FakeYouTube.instances.at(-1);
    if (!player) throw new Error('Player YouTube non creato.');
    await act(async () => player.options.events.onReady?.());
    return { container, player, changes, onPlaying };
  }

  it('prepara la coda come playlist senza avviarla', async () => {
    const { container, player } = await mountQueue();
    expect(player.options.videoId).toBe(id('a'));
    expect(player.cuePlaylist).toHaveBeenCalledWith([id('a'), id('b'), id('c')], 0, 0);
    expect(player.loadPlaylist).not.toHaveBeenCalled();
    expect(player.loadVideoById).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Coda YouTube · 1 di 3');
  });

  it('segue l’avanzamento di YouTube e usa nextVideo / previousVideo / playVideoAt', async () => {
    const { container, player } = await mountQueue();
    await player.state(PLAYING);
    await player.state(ENDED);
    expect(container.textContent).toContain('Coda YouTube · 1 di 3');
    player.autoAdvance();
    await player.state(PLAYING);
    expect(container.textContent).toContain('Coda YouTube · 2 di 3');
    expect(player.switches()).toBe(0);

    await act(async () => button(container, 'Successivo').click());
    expect(player.nextVideo).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Coda YouTube · 3 di 3');
    await player.state(PLAYING);

    await act(async () => button(container, 'Precedente').click());
    expect(player.previousVideo).toHaveBeenCalledTimes(1);
    await player.state(PLAYING);
    const first = [...container.querySelectorAll<HTMLButtonElement>('ol button')].find((item) =>
      item.textContent?.includes('Primo video'),
    );
    await act(async () => first?.click());
    expect(player.previousVideo).toHaveBeenCalledTimes(2);
    await player.state(PLAYING);
    const third = [...container.querySelectorAll<HTMLButtonElement>('ol button')].find((item) =>
      item.textContent?.includes('Terzo video'),
    );
    await act(async () => third?.click());
    expect(player.playVideoAt).toHaveBeenCalledWith(2);
    expect(player.loadVideoById).not.toHaveBeenCalled();
    expect(player.loadPlaylist).not.toHaveBeenCalled();
  });

  it('la fine dell’ultimo video chiude la coda', async () => {
    const { container, player } = await mountQueue();
    for (let step = 0; step < 2; step += 1) {
      await player.state(PLAYING);
      await player.state(ENDED);
      player.autoAdvance();
    }
    await player.state(PLAYING);
    expect(container.textContent).toContain('Coda YouTube · 3 di 3');
    await player.state(ENDED);
    expect(container.textContent).toContain('Coda YouTube terminata.');
  });

  it('a pagina nascosta il video avviato da YouTube viene fermato subito', async () => {
    const { container, player, onPlaying } = await mountQueue();
    await player.state(PLAYING);
    expect(onPlaying).toHaveBeenCalledTimes(1);
    await setHidden(true);
    await player.state(ENDED);
    player.autoAdvance();
    player.pauseVideo.mockClear();
    await player.state(PLAYING);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    // Paused at once: the page is not told that a video plays (Solco audio keeps going).
    expect(onPlaying).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Coda YouTube · 2 di 3');
  });

  it('a pagina nascosta si ferma anche il video chiesto con “Successivo” appena prima', async () => {
    const { container, player, onPlaying } = await mountQueue();
    await player.state(PLAYING);
    await act(async () => button(container, 'Successivo').click());
    expect(player.nextVideo).toHaveBeenCalledTimes(1);

    await setHidden(true);
    player.pauseVideo.mockClear();
    await player.state(BUFFERING);
    expect(player.pauseVideo).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Coda YouTube · 2 di 3');
    expect(onPlaying).toHaveBeenCalledTimes(1);
  });

  it('a pagina nascosta, senza cueVideoById, non carica un video che partirebbe da solo', async () => {
    const { container, player } = await mountQueue();
    // A player that can neither cue a playlist nor a single video.
    Reflect.deleteProperty(player, 'cuePlaylist');
    await setHidden(true);
    await act(async () => button(container, 'Successivo').click());

    expect(container.textContent).toContain('Coda YouTube · 2 di 3');
    expect(player.loadVideoById).not.toHaveBeenCalled();
    expect(player.loadPlaylist).not.toHaveBeenCalled();
    expect(player.nextVideo).not.toHaveBeenCalled();
    expect(player.playVideoAt).not.toHaveBeenCalled();
  });
});
