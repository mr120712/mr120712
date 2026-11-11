// @polsia:user-owned — passaggio senza silenzio: due elementi <audio> (attivo + riserva) nel
// player condiviso. La riserva carica i primi secondi del brano Audius/Solco successivo ~20 s
// prima della fine e parte nello stesso evento 'ended'; ogni altro caso resta sul percorso a un
// solo elemento.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
  loadYouTubeIframeApi: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('@/components/custom/music/youtube-queue-player', () => ({
  loadYouTubeIframeApi: mocks.loadYouTubeIframeApi,
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
const audiusC: MusicPlayerTrack = { ...audiusA, qualifiedId: 'audius:track-c', title: 'Cielo' };
const solco1: MusicPlayerTrack = {
  ...audiusA,
  qualifiedId: 'audius:track-1',
  title: 'Primo brano',
  albumId: 'album-1',
  playbackMode: 'solco',
};
const solco2: MusicPlayerTrack = { ...solco1, qualifiedId: 'audius:track-2', title: 'Secondo' };
const episode1: MusicPlayerTrack = {
  qualifiedId: 'podcast:123~ep1',
  title: 'Episodio 1',
  artistName: 'Show',
  sourceLabel: 'Podcast',
  sourceUrl: null,
  durationSeconds: 200,
  playbackMode: 'podcast',
};
const episode2: MusicPlayerTrack = { ...episode1, qualifiedId: 'podcast:123~ep2', title: 'Ep 2' };
const video: MusicPlayerTrack = {
  qualifiedId: 'youtube:aaaaaaaaaaa',
  title: 'Video in coda',
  artistName: 'Canale',
  sourceLabel: 'YouTube',
  sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  playbackMode: 'youtube',
};

const STREAM_A = '/api/music/audius/tracks/track-a/stream';
const STREAM_B = '/api/music/audius/tracks/track-b/stream';
const STREAM_C = '/api/music/audius/tracks/track-c/stream';

const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia Audius': [audiusA, audiusB],
  'Avvia tre': [audiusA, audiusB, audiusC],
  'Avvia Solco': [solco1, solco2],
  'Avvia poi podcast': [audiusA, episode1],
  'Avvia poi video': [audiusA, video],
  'Avvia podcast': [episode1, episode2],
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
      <output data-testid="status">{player.status}</output>
      <output data-testid="elapsed">{Math.floor(player.elapsedSeconds)}</output>
    </>
  );
}

type Handler = ((details: MediaSessionActionDetails) => void) | null;
type MediaState = {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
  error: MediaError | null;
};

const roots: Array<ReturnType<typeof createRoot>> = [];
const states = new WeakMap<HTMLMediaElement, MediaState>();
let access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
let playsResponse: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let handlers: Map<string, Handler>;
let session: {
  metadata: { title?: string } | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
};
let audioSession: { type: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function fakeMedia(audio: HTMLAudioElement): MediaState {
  const state: MediaState = {
    currentTime: 0,
    duration: Number.NaN,
    paused: true,
    ended: false,
    playbackRate: 1,
    readyState: 0,
    error: null,
  };
  for (const key of Object.keys(state) as Array<keyof MediaState>) {
    Object.defineProperty(audio, key, {
      configurable: true,
      get: () => state[key],
      set: (value: never) => {
        state[key] = value;
      },
    });
  }
  states.set(audio, state);
  return state;
}

const play = () => vi.mocked(HTMLMediaElement.prototype.play);
const pause = () => vi.mocked(HTMLMediaElement.prototype.pause);
const load = () => vi.mocked(HTMLMediaElement.prototype.load);

function fetchPaths() {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Pulsante ${label} non trovato.`);
  return found;
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
  const decks = [...container.querySelectorAll('audio')];
  expect(decks).toHaveLength(2);
  const [first, second] = decks as [HTMLAudioElement, HTMLAudioElement];
  return { container, first, second, a: fakeMedia(first), b: fakeMedia(second) };
}

async function start(container: HTMLElement, label: string) {
  await act(async () => {
    button(container, label).click();
    await flush();
  });
}

async function fire(audio: HTMLAudioElement, type: string) {
  await act(async () => {
    audio.dispatchEvent(new Event(type));
    await flush();
  });
}

/** `left` seconds before the end of the active deck: the next item is prepared (and preloaded). */
async function nearEnd(audio: HTMLAudioElement, state: MediaState, left = 15, duration = 200) {
  state.duration = duration;
  state.currentTime = duration - left;
  state.paused = false;
  await fire(audio, 'timeupdate');
  await act(flush);
}

/** HTML order at the end of a resource: 'pause' then 'ended', in one task. */
function endTrack(audio: HTMLAudioElement, state: MediaState) {
  state.currentTime = state.duration;
  state.paused = true;
  state.ended = true;
  audio.dispatchEvent(new Event('pause'));
  audio.dispatchEvent(new Event('ended'));
}

/** Every value the player writes to `audio.preload` (the attribute still changes). */
function recordPreload(audio: HTMLAudioElement) {
  const reflected = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'preload');
  const written: string[] = [];
  Object.defineProperty(audio, 'preload', {
    configurable: true,
    get: () => reflected?.get?.call(audio),
    set: (value: string) => {
      written.push(value);
      reflected?.set?.call(audio, value);
    },
  });
  return written;
}

function text(container: HTMLElement, id: string) {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent;
}

function audible(...decks: HTMLAudioElement[]) {
  return decks.filter((deck) => states.get(deck)?.paused === false);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
  playsResponse = async () => json({ allowed: true, used: 4, limit: 40 });
  fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith('/api/music/access')) return json(access);
    if (path.startsWith('/api/music/plays')) return playsResponse();
    if (path.startsWith('/api/rewards')) return json({ counted: true });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  mocks.loadYouTubeIframeApi.mockReset().mockResolvedValue({
    Player: function Player() {
      return {
        loadVideoById: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: () => 0,
        getDuration: () => 0,
        destroy: vi.fn(),
      };
    },
  });
  handlers = new Map();
  session = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn((action: string, handler: Handler) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  audioSession = { type: 'auto' };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  Object.defineProperty(navigator, 'audioSession', { configurable: true, value: audioSession });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    },
  );
  // Fake engine: play() makes the element audible, pause() and load() silence it (HTML load
  // algorithm), load() also drops the buffered data.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    const state = states.get(this);
    if (state) {
      state.paused = false;
      state.ended = false;
    }
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    const state = states.get(this);
    if (state) state.paused = true;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    const state = states.get(this);
    if (state) {
      state.paused = true;
      state.readyState = 0;
      state.currentTime = 0;
    }
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Reflect.deleteProperty(navigator, 'mediaSession');
  Reflect.deleteProperty(navigator, 'audioSession');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('precaricamento sulla riserva', () => {
  it('~20 s prima della fine carica i primi secondi del successivo, senza contare ascolti', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    const preloads = [recordPreload(first), recordPreload(second)];
    await start(container, 'Avvia Audius');
    expect(first.getAttribute('src')).toBe(STREAM_A);
    expect(second.getAttribute('src')).toBeNull();

    // 50 s left: nothing prepared yet.
    await nearEnd(first, a, 50);
    expect(second.getAttribute('src')).toBeNull();

    load().mockClear();
    await nearEnd(first, a, 19);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/music/audius/tracks/track-b/playback',
      expect.anything(),
    );
    expect(second.getAttribute('src')).toBe(STREAM_B);
    // Never 'auto': a paused element on 'auto' asks for the counted continuation by itself.
    expect(second.preload).toBe('metadata');
    expect(load().mock.contexts).toEqual([second]);
    // A preload never starts a play: no POST /plays and no play() on the spare.
    expect(fetchPaths().filter((path) => path === '/api/music/plays')).toHaveLength(1);
    expect(play().mock.contexts).not.toContain(second);
    expect(audible(first, second)).toEqual([first]);
    // The playing deck is untouched.
    expect(first.getAttribute('src')).toBe(STREAM_A);

    // The spare's own events never drive the player.
    b.readyState = 2;
    await fire(second, 'loadeddata');
    b.currentTime = 7;
    await fire(second, 'timeupdate');
    await fire(second, 'pause');
    await fire(second, 'ended');
    expect(text(container, 'elapsed')).toBe('181');
    expect(text(container, 'status')).toBe('playing');
    expect(first.getAttribute('src')).toBe(STREAM_A);
    expect(second.preload).toBe('metadata');

    // Through the gapless advance too, no deck ever gets preload='auto'.
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(second.getAttribute('src')).toBe(STREAM_B);
    expect(preloads.flat()).not.toContain('auto');
  });

  it('precarica anche i brani degli album Solco', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia Solco');
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBe('/api/music/albums/album-1/tracks/track-2/stream');
  });

  it.each([
    ['un podcast', 'Avvia poi podcast', '/api/music/podcasts/123/episodes/ep1/stream'],
    ['un video YouTube', 'Avvia poi video', null],
  ])(
    'se il successivo è %s non precarica e resta sul percorso a un elemento',
    async (_label, queue, nextSrc) => {
      const { container, first, second, a } = await mountPlayer();
      await start(container, queue);
      await nearEnd(first, a);
      expect(second.getAttribute('src')).toBeNull();
      play().mockClear();
      await act(async () => {
        endTrack(first, a);
        await flush();
      });
      expect(play().mock.contexts).not.toContain(second);
      expect(second.getAttribute('src')).toBeNull();
      expect(first.getAttribute('src')).toBe(nextSrc);
    },
  );

  it('i podcast non usano mai la riserva', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia podcast');
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBeNull();
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(first.getAttribute('src')).toBe('/api/music/podcasts/123/episodes/ep2/stream');
    expect(second.getAttribute('src')).toBeNull();
  });

  it('niente precaricamento quando il limite Free fermerebbe il successivo', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia Audius');
    access = { premium: false, signedIn: true, playsUsed: 40, playsLimit: 40 };
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBeNull();
  });
});

describe('fine brano con la riserva pronta', () => {
  it('play() sulla riserva nello stesso evento, ruoli scambiati, deck vecchio liberato', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    b.readyState = 3;
    await act(async () => setHidden(true));
    play().mockClear();
    load().mockClear();
    session.playbackState = 'paused';
    const apiCalls = mocks.apiFetch.mock.calls.length;
    const fetchCalls = fetchMock.mock.calls.length;

    await act(async () => {
      endTrack(first, a);
      // Same task as 'ended': no await, no network request before play().
      expect(play().mock.contexts).toEqual([second]);
      expect(audible(first, second)).toEqual([second]);
      expect(second.getAttribute('src')).toBe(STREAM_B);
      // Old deck released after the swap.
      expect(first.getAttribute('src')).toBeNull();
      expect(load().mock.contexts).toEqual([first]);
      expect(session.metadata?.title).toBe('Brezza');
      expect(session.playbackState).toBe('playing');
      expect(audioSession.type).toBe('playback');
      expect(mocks.apiFetch.mock.calls.length).toBe(apiCalls);
      expect(fetchMock.mock.calls.length).toBe(fetchCalls);
      await flush();
    });
    expect(container.textContent).toContain('Brezza');

    // The former spare now drives the player; the old deck's late events are ignored.
    b.currentTime = 0.5;
    const before = fetchMock.mock.calls.length;
    await fire(second, 'playing');
    expect(text(container, 'status')).toBe('playing');
    // The continuation counts the play server-side: the counter is refreshed, no POST /plays.
    expect(fetchPaths().slice(before)).toContain('/api/music/access');
    expect(fetchPaths().slice(before)).not.toContain('/api/music/plays');
    b.currentTime = 7;
    await fire(second, 'timeupdate');
    expect(text(container, 'elapsed')).toBe('7');
    a.currentTime = 42;
    await fire(first, 'timeupdate');
    await fire(first, 'pause');
    expect(text(container, 'elapsed')).toBe('7');
    expect(text(container, 'status')).toBe('playing');

    // Pause (lock screen) pauses the active deck only.
    pause().mockClear();
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    expect(pause().mock.contexts).toEqual([second]);
    expect(audible(first, second)).toEqual([]);
    expect(text(container, 'status')).toBe('paused');
  });

  it('i ruoli si alternano: il deck liberato precarica il brano dopo', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia tre');
    await nearEnd(first, a);
    b.readyState = 3;
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    await fire(second, 'playing');
    await nearEnd(second, b);
    expect(first.getAttribute('src')).toBe(STREAM_C);
    a.readyState = 4;
    play().mockClear();
    await act(async () => {
      endTrack(second, b);
      await flush();
    });
    expect(play().mock.contexts).toEqual([first]);
    expect(second.getAttribute('src')).toBeNull();
    expect(container.textContent).toContain('Cielo');
    expect(session.metadata?.title).toBe('Cielo');
  });

  it('se play() sulla riserva fallisce torna al cambio di src sul deck che suonava', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    b.readyState = 3;
    const playing = play().getMockImplementation();
    play()
      .mockClear()
      .mockImplementation(function (this: HTMLMediaElement) {
        if (this === second) {
          return Promise.reject(new DOMException('Formato non valido', 'NotSupportedError'));
        }
        return playing?.call(this) ?? Promise.resolve();
      });
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(play().mock.contexts).toEqual([second, first]);
    expect(first.getAttribute('src')).toBe(STREAM_B);
    expect(second.getAttribute('src')).toBeNull();
    expect(audible(first, second)).toEqual([first]);
    await fire(first, 'playing');
    expect(text(container, 'status')).toBe('playing');
    expect(container.textContent).toContain('Brezza');
    expect(session.metadata?.title).toBe('Brezza');
  });

  it('Media Session: con "playing" prima del render la posizione resta quella del nuovo deck', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    // preload='metadata' may stop the spare at HAVE_METADATA, its duration already known; those
    // events fired while it was the spare and were ignored.
    b.readyState = 1;
    b.duration = 180;
    session.setPositionState.mockClear();
    await act(async () => {
      endTrack(first, a);
      // A deck with data queues 'playing' at once: it can run before React renders the new item.
      second.dispatchEvent(new Event('playing'));
      await flush();
    });
    expect(play().mock.contexts.at(-1)).toBe(second);
    expect(container.textContent).toContain('Brezza');
    const position = { duration: 180, position: 0, playbackRate: 1 };
    expect(session.setPositionState).toHaveBeenLastCalledWith(position);
    // Nothing clears it afterwards while the track plays.
    b.currentTime = 3;
    await fire(second, 'timeupdate');
    expect(session.setPositionState).toHaveBeenLastCalledWith(position);
  });

  it('riserva non ancora pronta: cambio di src sull’elemento attivo e riserva liberata', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBe(STREAM_B);
    // HAVE_NOTHING: not even the metadata of its preload yet.
    b.readyState = 0;
    play().mockClear();
    await act(async () => {
      endTrack(first, a);
      expect(play().mock.contexts).toEqual([first]);
      await flush();
    });
    expect(first.getAttribute('src')).toBe(STREAM_B);
    expect(second.getAttribute('src')).toBeNull();
    expect(container.textContent).toContain('Brezza');
  });

  it('un precaricamento fallito libera la riserva senza messaggi', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    await fire(second, 'error');
    expect(second.getAttribute('src')).toBeNull();
    expect(text(container, 'status')).toBe('playing');
    expect(container.textContent).not.toContain('errore');
    expect(first.getAttribute('src')).toBe(STREAM_A);
  });
});

describe('salti', () => {
  it('"successivo" usa la riserva per lo stesso brano, zittendo prima il deck attivo', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    b.readyState = 3;
    play().mockClear();
    pause().mockClear();
    await act(async () => {
      button(container, 'Brano successivo').click();
      await flush();
    });
    expect(play().mock.contexts).toEqual([second]);
    const pausedFirst = pause().mock.contexts.indexOf(first);
    expect(pausedFirst).toBeGreaterThanOrEqual(0);
    expect(pause().mock.invocationCallOrder[pausedFirst]).toBeLessThan(
      play().mock.invocationCallOrder[0] ?? 0,
    );
    expect(audible(first, second)).toEqual([second]);
    expect(first.getAttribute('src')).toBeNull();
    expect(container.textContent).toContain('Brezza');
  });

  it('"successivo" dalla schermata di blocco usa la riserva', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    b.readyState = 4;
    play().mockClear();
    await act(async () => {
      handlers.get('nexttrack')?.({ action: 'nexttrack' });
      await flush();
    });
    expect(play().mock.contexts).toEqual([second]);
    expect(session.metadata?.title).toBe('Brezza');
  });

  it('"precedente" non usa la riserva, che contiene un altro brano', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia tre');
    // Mid-track skip to B (nothing prepared): normal path with network checks.
    await act(async () => {
      button(container, 'Brano successivo').click();
      await flush();
    });
    expect(first.getAttribute('src')).toBe(STREAM_B);
    // A short track: 3 s in and already within 20 s of its end, so C is preloaded.
    await nearEnd(first, a, 17, 20);
    expect(second.getAttribute('src')).toBe(STREAM_C);
    b.readyState = 4;
    play().mockClear();
    await act(async () => {
      button(container, 'Brano precedente').click();
      await flush();
    });
    expect(play().mock.contexts).not.toContain(second);
    expect(second.getAttribute('src')).toBeNull();
    expect(first.getAttribute('src')).toBe(STREAM_A);
    expect(container.textContent).toContain('Alba');
  });
});

describe('riserva liberata', () => {
  it('chiudendo il player', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBe(STREAM_B);
    await act(async () => button(container, 'Chiudi il player').click());
    expect(second.getAttribute('src')).toBeNull();
    expect(first.getAttribute('src')).toBeNull();
    expect(audible(first, second)).toEqual([]);
  });

  it('con una nuova coda', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBe(STREAM_B);
    await start(container, 'Avvia podcast');
    expect(second.getAttribute('src')).toBeNull();
    expect(first.getAttribute('src')).toBe('/api/music/podcasts/123/episodes/ep1/stream');
  });

  it('con "ripeti brano" (il brano va in loop, nessun successivo)', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await nearEnd(first, a);
    await act(async () => button(container, 'Ripeti: disattivato').click());
    // Repeat all: the next item is still B.
    expect(second.getAttribute('src')).toBe(STREAM_B);
    await act(async () => button(container, 'Ripeti: tutta la coda').click());
    expect(second.getAttribute('src')).toBeNull();
    await nearEnd(first, a, 10);
    expect(second.getAttribute('src')).toBeNull();
  });

  it('quando la casuale cambia il successivo, e precarica quello nuovo', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia tre');
    await nearEnd(first, a);
    expect(second.getAttribute('src')).toBe(STREAM_B);
    await act(async () => button(container, 'Riproduzione casuale').click());
    expect(second.getAttribute('src')).toBeNull();
    await nearEnd(first, a, 14);
    expect(second.getAttribute('src')).toBe(STREAM_C);
  });
});

describe('sblocco iOS nel primo tocco', () => {
  it('entrambi gli elementi ricevono load() dentro il tocco, prima di qualsiasi attesa', async () => {
    // The permit never answers: anything after the first await cannot have run.
    playsResponse = () => new Promise(() => undefined);
    const { container, first, second } = await mountPlayer();
    load().mockClear();
    act(() => {
      button(container, 'Avvia Audius').click();
    });
    expect(new Set(load().mock.contexts)).toEqual(new Set([first, second]));
    expect(play()).not.toHaveBeenCalled();
  });

  it('play da schermata di blocco su una coda in pausa sblocca anche la riserva', async () => {
    const { container, first, second } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    load().mockClear();
    act(() => {
      handlers.get('play')?.({ action: 'play' });
    });
    // The playing deck keeps its source (already unlocked); the idle spare gets its load().
    expect(load().mock.contexts).toEqual([second]);
    expect(play().mock.contexts.at(-1)).toBe(first);
    await act(flush);
  });
});
