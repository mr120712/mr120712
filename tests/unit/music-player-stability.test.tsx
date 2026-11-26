// @polsia:user-owned — regressioni sulla stabilità del player condiviso: punto di ripresa che non
// passa a un altro brano, avvii trattenuti (iOS, pause di sistema) che non diventano errori, code
// YouTube che non girano all'infinito, errori in pausa o senza rete, dirette che cadono, autoplay
// continuo a schermo bloccato, smontaggio pulito e avanzamento che non ridisegna tutto.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
  loadYouTubeIframeApi: vi.fn(),
  imageRenders: { count: 0 },
}));
const auth = vi.hoisted(() => ({
  state: { data: { user: { id: 'u1' } }, isPending: false } as {
    data: { user: { id: string } } | null;
    isPending: boolean;
  },
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => auth.state }));
vi.mock('@/lib/music/youtube-iframe-api', () => ({
  loadYouTubeIframeApi: mocks.loadYouTubeIframeApi,
}));
// Conta i render delle copertine (la coda del player a schermo intero ne disegna una per brano).
vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => {
    mocks.imageRenders.count += 1;
    return <span data-image={props.src} data-alt={props.alt} />;
  },
}));

import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
  useMusicPlayerElapsed,
} from '@/components/custom/music/music-player';
import {
  failureMessage,
  OFFLINE_RESUME_MESSAGE,
  UNAVAILABLE_SKIP_MESSAGE,
  YOUTUBE_QUEUE_UNPLAYABLE_MESSAGE,
} from '@/lib/music/player-messages';
import { PLAYER_STORAGE_KEY } from '@/lib/music/player-session';

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
const episode1: MusicPlayerTrack = {
  qualifiedId: 'podcast:123~ep1',
  title: 'Episodio 1',
  artistName: 'Show',
  sourceLabel: 'Podcast',
  sourceUrl: null,
  durationSeconds: 600,
  playbackMode: 'podcast',
};
const episode2: MusicPlayerTrack = { ...episode1, qualifiedId: 'podcast:123~ep2', title: 'Ep 2' };
const episode3: MusicPlayerTrack = { ...episode1, qualifiedId: 'podcast:123~ep3', title: 'Ep 3' };
const episode4: MusicPlayerTrack = { ...episode1, qualifiedId: 'podcast:123~ep4', title: 'Ep 4' };
const episode5: MusicPlayerTrack = { ...episode1, qualifiedId: 'podcast:123~ep5', title: 'Ep 5' };
const station1: MusicPlayerTrack = {
  qualifiedId: 'radio:station-1',
  title: 'Radio uno',
  artistName: 'Diretta',
  sourceLabel: 'Radio',
  sourceUrl: null,
  playbackMode: 'radio',
};
const station2: MusicPlayerTrack = { ...station1, qualifiedId: 'radio:station-2', title: 'Due' };
const video1: MusicPlayerTrack = {
  qualifiedId: 'youtube:aaaaaaaaaaa',
  title: 'Primo video',
  artistName: 'Canale',
  sourceLabel: 'YouTube',
  sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  playbackMode: 'youtube',
};
const video2: MusicPlayerTrack = {
  ...video1,
  qualifiedId: 'youtube:bbbbbbbbbbb',
  title: 'Secondo video',
  sourceUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
};
const songA: MusicPlayerTrack = {
  qualifiedId: `song:${'a'.repeat(32)}`,
  title: 'Strada Nuova',
  artistName: 'Band Finta',
  sourceLabel: 'YouTube',
  sourceUrl: null,
  playbackMode: 'song',
};
const songB: MusicPlayerTrack = { ...songA, qualifiedId: `song:${'b'.repeat(32)}`, title: 'Mare' };
const manyTracks: MusicPlayerTrack[] = Array.from({ length: 30 }, (_, index) => ({
  ...audiusA,
  qualifiedId: `audius:many-${index}`,
  title: `Brano ${index}`,
  artworkUrl: `https://audius.co/images/${index}.jpg`,
}));

const STREAM_A = '/api/music/audius/tracks/track-a/stream';
const STREAM_EP1 = '/api/music/podcasts/123/episodes/ep1/stream';
const STREAM_EP2 = '/api/music/podcasts/123/episodes/ep2/stream';
const STREAM_EP3 = '/api/music/podcasts/123/episodes/ep3/stream';
const STREAM_RADIO1 = '/api/music/radio/station-1/stream';

const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia Audius': [audiusA, audiusB],
  'Avvia Alba': [audiusA],
  'Avvia ep1': [episode1],
  'Avvia ep2': [episode2],
  'Avvia episodi': [episode1, episode2],
  'Avvia tre episodi': [episode1, episode2, episode3],
  'Avvia cinque episodi': [episode1, episode2, episode3, episode4, episode5],
  'Avvia misto': [episode1, video1, episode2],
  'Avvia radio': [station1, station2],
  'Avvia una radio': [station1],
  'Avvia video': [video1, video2],
  'Avvia brani importati': [songA, songB],
  'Avvia coda lunga': manyTracks,
};

const renders = { status: 0 };

function StatusOnly() {
  const { status } = useMusicPlayer();
  renders.status += 1;
  return <output data-testid="status-only">{status}</output>;
}

function Probe() {
  const player = useMusicPlayer();
  const elapsed = useMusicPlayerElapsed();
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
      <button type="button" onClick={player.cycleRepeat}>
        Ripeti
      </button>
      <button type="button" onClick={player.toggleShuffle}>
        Casuale
      </button>
      <output data-testid="status">{player.status}</output>
      <output data-testid="current">{player.currentTrack?.qualifiedId ?? ''}</output>
      <output data-testid="error">{player.errorMessage ?? ''}</output>
      <output data-testid="block">{player.playBlock ?? ''}</output>
      <output data-testid="queue">{player.queue.length}</output>
      <output data-testid="elapsed">{Math.floor(elapsed)}</output>
    </>
  );
}

type MediaState = {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
  error: MediaError | null;
};
type Handler = ((details: MediaSessionActionDetails) => void) | null;
type YouTubeEvents = {
  onReady: () => void;
  onStateChange: (event: { data: number }) => void;
  onError: (event: { data: number }) => void;
};

const roots: Array<ReturnType<typeof createRoot>> = [];
const states = new WeakMap<HTMLMediaElement, MediaState>();
let access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
let playsResponse: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let playImpl: (() => Promise<void>) | null;
let handlers: Map<string, Handler>;
let session: {
  metadata: { title?: string } | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
};
let audioSession: { type: string };
let ytEvents: YouTubeEvents | null;
let ytPlayerVars: Record<string, unknown> | null;
const yt = {
  loadVideoById: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  seekTo: vi.fn(),
  getCurrentTime: () => 0,
  getDuration: () => 200,
  destroy: vi.fn(),
};
const playerConstructed = vi.fn();
const youtubeApi = {
  Player: function Player(
    _element: HTMLElement,
    options: { events: YouTubeEvents; playerVars: Record<string, unknown> },
  ) {
    playerConstructed();
    ytEvents = options.events;
    ytPlayerVars = options.playerVars;
    return yt;
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
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

function fetchPaths() {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

function apiPaths() {
  return mocks.apiFetch.mock.calls.map(([path]) => String(path));
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Pulsante ${label} non trovato.`);
  return found;
}

function text(container: HTMLElement, id: string) {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent;
}

const fakeRouter = {
  push: vi.fn(async () => true),
  replace: vi.fn(async () => true),
  prefetch: vi.fn(async () => undefined),
  beforePopState: vi.fn(),
};

function tree(withRouter: boolean) {
  const player = (
    <MusicPlayerProvider>
      <Probe />
      <StatusOnly />
    </MusicPlayerProvider>
  );
  return withRouter ? (
    <RouterContext.Provider value={fakeRouter as never}>{player}</RouterContext.Provider>
  ) : (
    player
  );
}

async function mountPlayer({ withRouter = false } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(tree(withRouter)));
  await act(flush);
  const [first, second] = [...container.querySelectorAll('audio')] as [
    HTMLAudioElement,
    HTMLAudioElement,
  ];
  return { container, root, first, second, a: fakeMedia(first), b: fakeMedia(second) };
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

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await flush();
  });
}

/** Metadata of a new source: the player applies any pending resume point here. */
async function loadedMetadata(audio: HTMLAudioElement, state: MediaState, duration: number) {
  state.duration = duration;
  state.readyState = 1;
  await fire(audio, 'loadedmetadata');
}

/** HTML order at the end of a resource: 'pause' then 'ended', in one task. */
function endTrack(audio: HTMLAudioElement, state: MediaState) {
  state.currentTime = Number.isFinite(state.duration) ? state.duration : state.currentTime;
  state.paused = true;
  state.ended = true;
  audio.dispatchEvent(new Event('pause'));
  audio.dispatchEvent(new Event('ended'));
}

/** The active deck: the one holding a source (or the first one). */
function activeDeck(first: HTMLAudioElement, second: HTMLAudioElement) {
  return second.getAttribute('src') && !first.getAttribute('src') ? second : first;
}

function trendingTrack(id: string) {
  return {
    qualifiedId: `audius:${id}`,
    title: `Consigliato ${id}`,
    artistName: 'Artista consigliato',
    artistUrl: 'https://audius.co/artista',
    artworkUrl: null,
    trackUrl: `https://audius.co/artista/${id}`,
    durationSeconds: 180,
    playbackEligible: true,
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  renders.status = 0;
  mocks.imageRenders.count = 0;
  auth.state = { data: { user: { id: 'u1' } }, isPending: false };
  access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
  playsResponse = async () => json({ allowed: true, used: 4, limit: 40 });
  playImpl = null;
  ytEvents = null;
  ytPlayerVars = null;
  for (const fn of Object.values(yt)) {
    if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
  }
  playerConstructed.mockClear();
  fakeRouter.push.mockClear();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('/api/music/access')) return json(access);
    if (path.startsWith('/api/music/plays')) return playsResponse();
    if (path.startsWith('/api/rewards')) return json({ counted: true });
    if (path.startsWith('/api/music/resolve-song')) {
      if (init?.method === 'POST') return json({ ok: true });
      const title = new URL(path, 'https://solco.test').searchParams.get('title');
      const videoId = title === 'Mare' ? 'ddddddddddd' : 'ccccccccccc';
      return json({ video: { videoId, title, channelTitle: 'Canale', thumbnailUrl: null } });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  mocks.loadYouTubeIframeApi.mockReset().mockResolvedValue(youtubeApi);
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
  // algorithm), load() also drops the buffered data and the position.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (playImpl) return playImpl();
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
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  setOnline(true);
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('punto di ripresa: vale solo per il suo brano', () => {
  it('un ritentativo fallito non fa partire a metà il brano scelto dopo (ma lo stesso riprende)', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia ep1');
    a.duration = 600;
    a.currentTime = 95;
    await fire(first, 'error'); // drop at 1:35 → one retry from there
    await fire(first, 'error'); // the retry fails before metadata (currentTime 0 after load)
    expect(text(container, 'status')).toBe('error');
    expect(first.getAttribute('src')).toBeNull();

    // The same episode resumes where it dropped…
    await act(async () => {
      button(container, 'Riproduci Episodio 1').click();
      await flush();
    });
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await loadedMetadata(first, a, 600);
    expect(a.currentTime).toBe(95);

    // …and a failed retry again, then another episode: it starts from the beginning.
    a.currentTime = 95;
    await fire(first, 'error');
    await fire(first, 'error');
    await start(container, 'Avvia ep2');
    expect(first.getAttribute('src')).toBe(STREAM_EP2);
    await loadedMetadata(first, a, 300);
    expect(a.currentTime).toBe(0);
  });

  it('la coda ripristinata non passa la sua posizione a un altro brano scelto', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ owner: 'u1', queue: [audiusA, audiusB], index: 0, position: 120 }),
    );
    const { container, first, a } = await mountPlayer();
    expect(text(container, 'current')).toBe(audiusA.qualifiedId);
    expect(text(container, 'status')).toBe('idle');

    await start(container, 'Avvia ep2');
    expect(first.getAttribute('src')).toBe(STREAM_EP2);
    await loadedMetadata(first, a, 100);
    // Before: 100 (clamped to the end) → 'ended' → the chosen episode was skipped.
    expect(a.currentTime).toBe(0);
  });

  it('Play sulla coda ripristinata riprende il brano salvato dal suo punto', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ owner: 'u1', queue: [audiusA, audiusB], index: 0, position: 120 }),
    );
    const { container, first, a } = await mountPlayer();
    await act(async () => {
      button(container, 'Riproduci Alba').click();
      await flush();
    });
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_A);
    await loadedMetadata(first, a, 200);
    expect(a.currentTime).toBe(120);
  });
});

describe('coda ripristinata in ritardo', () => {
  it('non sostituisce un brano che l’ascoltatore ha già avviato', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ owner: 'u1', queue: [audiusA], index: 0, position: 30 }),
    );
    auth.state = { data: null, isPending: true };
    const { container, root, first } = await mountPlayer();
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    expect(text(container, 'status')).toBe('playing');

    // The session arrives late: the restore effect runs now.
    auth.state = { data: { user: { id: 'u1' } }, isPending: false };
    await act(async () => root.render(tree(false)));
    await act(flush);
    expect(text(container, 'current')).toBe(episode1.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
  });
});

describe('avvii trattenuti: pausa, non errore', () => {
  it('iOS rifiuta play() dopo le verifiche di rete: in pausa, sorgente tenuta, Play riparte subito', async () => {
    playImpl = () => Promise.reject(new DOMException('Senza tocco', 'NotAllowedError'));
    const { container, first } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await settle();
    expect(text(container, 'status')).toBe('paused');
    expect(text(container, 'error')).toBe('');
    expect(first.getAttribute('src')).toBe(STREAM_A);
    expect(session.playbackState).toBe('paused');

    playImpl = null;
    const before = play().mock.calls.length;
    await act(async () => {
      button(container, 'Riproduci Alba').click();
      // play() inside the press itself, no network wait before it.
      expect(play().mock.calls.length).toBe(before + 1);
      await flush();
    });
    expect(text(container, 'status')).toBe('playing');
  });

  it('una pausa di sistema mentre la radio si collega non mostra «la stazione non risponde»', async () => {
    playImpl = () => Promise.reject(new DOMException('Interrotto', 'AbortError'));
    const { container, first } = await mountPlayer();
    await start(container, 'Avvia radio');
    await settle();
    expect(text(container, 'status')).toBe('paused');
    expect(text(container, 'error')).toBe('');
    expect(first.getAttribute('src')).toBe(STREAM_RADIO1);
  });

  it('una pausa di sistema durante l’avvio automatico del successivo non lascia «loading»', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia episodi');
    await fire(first, 'playing');
    a.duration = 600;
    const pending = deferred<void>();
    playImpl = () => pending.promise;
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(text(container, 'current')).toBe(episode2.qualifiedId);
    expect(text(container, 'status')).toBe('loading');

    await act(async () => {
      pending.reject(new DOMException('Chiamata in arrivo', 'AbortError'));
      a.paused = true;
      a.ended = false;
      first.dispatchEvent(new Event('pause'));
      await flush();
    });
    expect(text(container, 'status')).toBe('paused');
    expect(button(container, 'Riproduci Ep 2').disabled).toBe(false);
  });
});

describe('YouTube: errori di fila', () => {
  async function startVideos(container: HTMLElement, label: string) {
    await start(container, label);
    await settle();
    expect(playerConstructed).toHaveBeenCalledTimes(1);
  }

  async function failVideo(code = 150) {
    await act(async () => {
      ytEvents?.onError({ data: code });
      for (let i = 0; i < 3; i += 1) await flush();
    });
  }

  it('con «Ripeti tutta la coda» si ferma dopo un giro completo', async () => {
    const { container } = await mountPlayer();
    await act(async () => button(container, 'Ripeti').click());
    await startVideos(container, 'Avvia video');
    for (let i = 0; i < 8; i += 1) await failVideo();
    expect(yt.loadVideoById).toHaveBeenCalledTimes(1);
    expect(text(container, 'status')).toBe('error');
    expect(text(container, 'error')).toBe(YOUTUBE_QUEUE_UNPLAYABLE_MESSAGE);
    expect(fetchPaths().filter((path) => path.startsWith('/api/music/plays'))).toHaveLength(2);
  });

  it('in casuale si ferma dopo un giro completo', async () => {
    const { container } = await mountPlayer();
    await act(async () => button(container, 'Casuale').click());
    await startVideos(container, 'Avvia video');
    for (let i = 0; i < 8; i += 1) await failVideo(5);
    expect(yt.loadVideoById).toHaveBeenCalledTimes(1);
    expect(text(container, 'status')).toBe('error');
  });

  it('brani importati: trovare il video non azzera il conteggio dei fallimenti', async () => {
    const { container } = await mountPlayer();
    await act(async () => button(container, 'Ripeti').click());
    await startVideos(container, 'Avvia brani importati');
    await failVideo(); // the first song's video fails: the second song is looked up and loaded
    await failVideo(); // its video fails too: a full lap, the player stops
    expect(text(container, 'status')).toBe('error');
    const invalidations = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).startsWith('/api/music/resolve-song') && init?.method === 'POST',
    );
    expect(invalidations).toHaveLength(2);
    for (let i = 0; i < 6; i += 1) await failVideo();
    // Before: the first song's video was loaded again (the found video reset the count).
    expect(yt.loadVideoById).toHaveBeenCalledTimes(1);
  });

  it('fermandosi non promette «Passo al successivo»', async () => {
    const { container } = await mountPlayer();
    await startVideos(container, 'Avvia video');
    await failVideo(); // the first video fails, the second one loads
    await failVideo(); // the last one fails too: nothing follows
    expect(text(container, 'status')).toBe('error');
    expect(text(container, 'error')).not.toContain('Passo al successivo');
  });
});

describe('YouTube: player ufficiale creato dopo un avvio annullato', () => {
  it('accesso richiesto prima che l’API sia pronta: nessun player con autoplay', async () => {
    const api = deferred<typeof youtubeApi>();
    mocks.loadYouTubeIframeApi.mockReset().mockReturnValue(api.promise);
    playsResponse = async () => json({ allowed: false, reason: 'login_required' });
    const { container } = await mountPlayer();
    await start(container, 'Avvia video');
    await settle();
    expect(text(container, 'status')).toBe('idle');
    expect(text(container, 'block')).toBe('login_required');

    await act(async () => {
      api.resolve(youtubeApi);
      await flush();
    });
    expect(playerConstructed).not.toHaveBeenCalled();
  });

  it('player già creato, poi accesso negato: onReady lo tiene fermo', async () => {
    const plays = deferred<Response>();
    playsResponse = () => plays.promise;
    const { container } = await mountPlayer();
    await start(container, 'Avvia video');
    await settle();
    expect(playerConstructed).toHaveBeenCalledTimes(1);
    expect(ytPlayerVars?.autoplay).toBe(1);

    await act(async () => {
      plays.resolve(json({ allowed: false, reason: 'login_required' }));
      await flush();
    });
    yt.pauseVideo.mockClear();
    await act(async () => ytEvents?.onReady());
    expect(yt.pauseVideo).toHaveBeenCalled();
    expect(yt.loadVideoById).not.toHaveBeenCalled();
  });

  it('pausa (cuffie, schermata di blocco) mentre l’API si carica: il video non parte', async () => {
    const api = deferred<typeof youtubeApi>();
    mocks.loadYouTubeIframeApi.mockReset().mockReturnValue(api.promise);
    const { container } = await mountPlayer();
    await start(container, 'Avvia video');
    await settle();
    expect(text(container, 'status')).toBe('loading');
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    expect(text(container, 'status')).toBe('paused');

    await act(async () => {
      api.resolve(youtubeApi);
      await flush();
    });
    expect(playerConstructed).not.toHaveBeenCalled();
  });
});

describe('scelta del successivo fatta a pagina nascosta', () => {
  it('tornati su Solco prima della fine, il video in coda non viene saltato', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia misto');
    await fire(first, 'playing');
    await act(async () => setHidden(true));
    a.duration = 600;
    a.currentTime = 590;
    a.paused = false;
    await fire(first, 'timeupdate'); // prepared while hidden: the video is skipped (ep2)
    await act(async () => setHidden(false));
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(text(container, 'current')).toBe(video1.qualifiedId);
  });
});

describe('brano che non parte affatto', () => {
  it('escluso il limite Free, passa al successivo invece di fermare la coda', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia tre episodi');
    await fire(first, 'playing');
    a.duration = 600;
    await act(async () => {
      endTrack(first, a); // ep2 starts on the same deck, synchronously
      await flush();
    });
    expect(text(container, 'current')).toBe(episode2.qualifiedId);
    a.ended = false;
    await fire(first, 'error'); // stream refused at byte 0
    await settle();
    expect(text(container, 'current')).toBe(episode3.qualifiedId);
    expect(first.getAttribute('src')).toBe(STREAM_EP3);
    expect(text(container, 'error')).toBe(UNAVAILABLE_SKIP_MESSAGE);
  });

  it('con il limite Free raggiunto mostra il limite e non salta', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia tre episodi');
    await fire(first, 'playing');
    a.duration = 600;
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    access = { premium: false, signedIn: true, playsUsed: 40, playsLimit: 40 };
    a.ended = false;
    await fire(first, 'error');
    await settle();
    expect(text(container, 'current')).toBe(episode2.qualifiedId);
    expect(text(container, 'block')).toBe('monthly_limit');
    expect(first.getAttribute('src')).toBeNull();
  });

  it('dopo tre brani di fila che non partono si ferma (il problema non è il brano)', async () => {
    const { container, first } = await mountPlayer();
    await start(container, 'Avvia cinque episodi');
    for (let i = 0; i < 5; i += 1) {
      await fire(first, 'error');
      await settle();
    }
    expect(text(container, 'current')).toBe(episode3.qualifiedId);
    expect(text(container, 'status')).toBe('error');
    expect(first.getAttribute('src')).toBeNull();
  });

  it('un file in evidenza o caricato non dà più la colpa ad Audius', () => {
    expect(failureMessage(null, { playbackMode: 'upload' })).not.toContain('Audius');
  });
});

describe('errore con il player in pausa', () => {
  it('non fa ripartire l’audio da solo; Play riprende dal punto in cui era', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    a.duration = 600;
    a.currentTime = 300;
    await act(async () => button(container, 'Metti in pausa Episodio 1').click());
    expect(text(container, 'status')).toBe('paused');

    const before = play().mock.calls.length;
    await fire(first, 'error');
    expect(play().mock.calls.length).toBe(before);
    expect(text(container, 'status')).toBe('paused');
    expect(first.getAttribute('src')).toBeNull();

    await act(async () => {
      button(container, 'Riproduci Episodio 1').click();
      await flush();
    });
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await loadedMetadata(first, a, 600);
    expect(a.currentTime).toBe(300);
  });

  it('una radio in pausa non si riconnette da sola dopo un errore', async () => {
    const { container, first } = await mountPlayer();
    await start(container, 'Avvia una radio');
    await fire(first, 'playing');
    await act(async () => button(container, 'Metti in pausa Radio uno').click());
    const before = play().mock.calls.length;
    await fire(first, 'error');
    expect(play().mock.calls.length).toBe(before);
    expect(text(container, 'status')).toBe('paused');
  });

  /** ep1 in pausa a 5:00, poi una ripresa il cui play() resta in attesa (l'elemento riscarica). */
  async function pausedThenResumeRequested(press: (container: HTMLElement) => void) {
    const player = await mountPlayer();
    const { container, first, a } = player;
    await start(container, 'Avvia episodi');
    await fire(first, 'playing');
    a.duration = 600;
    a.currentTime = 300;
    await act(async () => button(container, 'Metti in pausa Episodio 1').click());
    expect(text(container, 'status')).toBe('paused');
    const pending = deferred<void>();
    playImpl = () => pending.promise;
    await act(async () => {
      press(container);
      await flush();
    });
    playImpl = null;
    return { ...player, pending };
  }

  async function failResume(
    first: HTMLAudioElement,
    pending: ReturnType<typeof deferred<void>>,
  ): Promise<number> {
    const before = play().mock.calls.length;
    await fire(first, 'error');
    // load() della nuova richiesta interrompe il play() della ripresa.
    await act(async () => {
      pending.reject(new DOMException('Interrotto', 'AbortError'));
      await flush();
    });
    await settle();
    return play().mock.calls.length - before;
  }

  it('Play dopo la pausa: se lo stream fallisce prima di partire riprova da solo dal punto', async () => {
    const { container, first, a, pending } = await pausedThenResumeRequested((root) =>
      button(root, 'Riproduci Episodio 1').click(),
    );
    expect(await failResume(first, pending)).toBe(1);
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    expect(text(container, 'current')).toBe(episode1.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    expect(text(container, 'error')).toBe('');
    await loadedMetadata(first, a, 600);
    expect(a.currentTime).toBe(300);
  });

  it('lo stesso con Play dalla schermata di blocco', async () => {
    const { container, first, a, pending } = await pausedThenResumeRequested(() =>
      handlers.get('play')?.({ action: 'play' }),
    );
    expect(await failResume(first, pending)).toBe(1);
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    expect(text(container, 'status')).toBe('playing');
    await loadedMetadata(first, a, 600);
    expect(a.currentTime).toBe(300);
  });

  it('Play e poi di nuovo pausa prima che parta: l’errore non fa ripartire l’audio', async () => {
    const { container, first, pending } = await pausedThenResumeRequested((root) =>
      button(root, 'Riproduci Episodio 1').click(),
    );
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    expect(await failResume(first, pending)).toBe(0);
    expect(text(container, 'status')).toBe('paused');
    expect(first.getAttribute('src')).toBeNull();
  });
});

describe('ripresa con un punto salvato che fallisce prima di partire', () => {
  async function pressPlay(container: HTMLElement) {
    await act(async () => {
      button(container, 'Riproduci Episodio 1').click();
      await flush();
    });
    await settle();
  }

  /** Stesso episodio, nessun salto al successivo; il prossimo Play riprende dal punto salvato. */
  async function expectKeptAt(
    container: HTMLElement,
    first: HTMLAudioElement,
    a: MediaState,
    seconds: number,
    duration: number,
  ) {
    expect(text(container, 'current')).toBe(episode1.qualifiedId);
    expect(text(container, 'status')).toBe('error');
    expect(text(container, 'error')).not.toBe(UNAVAILABLE_SKIP_MESSAGE);
    expect(first.getAttribute('src')).toBeNull();
    await pressPlay(container);
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await loadedMetadata(first, a, duration);
    expect(a.currentTime).toBe(seconds);
  }

  it('coda ripristinata', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ owner: 'u1', queue: [episode1, episode2], index: 0, position: 240 }),
    );
    const { container, first, a } = await mountPlayer();
    await pressPlay(container);
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await fire(first, 'error');
    await settle();
    await expectKeptAt(container, first, a, 240, 600);
  });

  it('errore in pausa, poi Play che fallisce di nuovo', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia episodi');
    await fire(first, 'playing');
    a.duration = 600;
    a.currentTime = 300;
    await act(async () => button(container, 'Metti in pausa Episodio 1').click());
    await fire(first, 'error'); // in pausa: sorgente liberata, punto ricordato
    await pressPlay(container);
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await fire(first, 'error');
    await settle();
    await expectKeptAt(container, first, a, 300, 600);
  });

  it('ripresa automatica al ritorno della rete', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia episodi');
    await fire(first, 'playing');
    a.duration = 3000;
    a.currentTime = 1200;
    setOnline(false);
    await fire(first, 'error');
    expect(text(container, 'error')).toBe(OFFLINE_RESUME_MESSAGE);
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await flush();
    });
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await fire(first, 'error'); // la prima richiesta dopo la riconnessione fallisce ancora
    await settle();
    await expectKeptAt(container, first, a, 1200, 3000);
  });
});

describe('senza rete', () => {
  it('non spreca il ritentativo e riprende da solo, dal punto giusto, quando torna la rete', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    a.duration = 3000;
    a.currentTime = 1200;
    setOnline(false);
    const before = play().mock.calls.length;
    await fire(first, 'error');
    expect(play().mock.calls.length).toBe(before);
    expect(text(container, 'status')).toBe('error');
    expect(text(container, 'error')).toBe(OFFLINE_RESUME_MESSAGE);
    expect(first.getAttribute('src')).toBeNull();

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await flush();
    });
    expect(play().mock.calls.length).toBe(before + 1);
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    await loadedMetadata(first, a, 3000);
    expect(a.currentTime).toBe(1200);
  });
});

describe('diretta radio', () => {
  it('una connessione chiusa dal server si riconnette, senza cambiare stazione', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia radio');
    await fire(first, 'playing');
    const before = play().mock.calls.length;
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(text(container, 'current')).toBe(station1.qualifiedId);
    expect(first.getAttribute('src')).toBe(STREAM_RADIO1);
    expect(play().mock.calls.length).toBe(before + 1);
  });

  it('una sola stazione che chiude non resta ferma su «ended»', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia una radio');
    await fire(first, 'playing');
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(text(container, 'status')).not.toBe('ended');
    expect(first.getAttribute('src')).toBe(STREAM_RADIO1);
  });

  it('uno stream appeso senza errore si riconnette dopo qualche secondo', async () => {
    const timers = vi.spyOn(window, 'setTimeout');
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia una radio');
    await fire(first, 'playing');
    a.currentTime = 50;
    a.paused = false;
    await fire(first, 'waiting');
    const watchdog = timers.mock.calls.find(([, delay]) => delay === 12_000);
    expect(watchdog).toBeDefined();
    const before = play().mock.calls.length;
    await act(async () => {
      (watchdog?.[0] as () => void)();
      await flush();
    });
    expect(play().mock.calls.length).toBe(before + 1);
    expect(first.getAttribute('src')).toBe(STREAM_RADIO1);
  });

  it('uno «stalled» mentre il buffer avanza non riconnette', async () => {
    const timers = vi.spyOn(window, 'setTimeout');
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia una radio');
    await fire(first, 'playing');
    a.currentTime = 50;
    await fire(first, 'stalled');
    const watchdog = timers.mock.calls.find(([, delay]) => delay === 12_000);
    a.currentTime = 62;
    const before = play().mock.calls.length;
    await act(async () => {
      (watchdog?.[0] as () => void)();
      await flush();
    });
    expect(play().mock.calls.length).toBe(before);
  });
});

describe('autoplay continuo', () => {
  it('una continuazione appesa non blocca quella della coda successiva', async () => {
    window.localStorage.setItem('solco:autoplay', '1');
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === '/api/music/trending' ? new Promise(() => undefined) : { allowed: true },
    );
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    a.duration = 600;
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(apiPaths().filter((path) => path === '/api/music/trending')).toHaveLength(1);
    expect(text(container, 'status')).toBe('loading');

    await act(async () => button(container, 'Chiudi il player').click());
    await start(container, 'Avvia ep2');
    const deck = activeDeck(first, second);
    const state = deck === first ? a : b;
    state.ended = false;
    await fire(deck, 'playing');
    state.duration = 600;
    await act(async () => {
      endTrack(deck, state);
      await flush();
    });
    expect(apiPaths().filter((path) => path === '/api/music/trending')).toHaveLength(2);
    expect(text(container, 'status')).toBe('loading');
  });

  it('una preparazione fallita non si ripete a ogni timeupdate', async () => {
    window.localStorage.setItem('solco:autoplay', '1');
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/music/trending')
        throw new Error('apiFetch /api/music/trending failed (500)');
      return { allowed: true };
    });
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia Alba');
    await fire(first, 'playing');
    a.duration = 200;
    a.paused = false;
    for (let second = 181; second <= 195; second += 1) {
      a.currentTime = second;
      await fire(first, 'timeupdate');
    }
    expect(apiPaths().filter((path) => path === '/api/music/trending')).toHaveLength(1);
  });

  it('a schermo bloccato il lotto preparato prima della fine parte nello stesso evento', async () => {
    window.localStorage.setItem('solco:autoplay', '1');
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === '/api/music/trending'
        ? { tracks: [trendingTrack('next-1'), trendingTrack('next-2')] }
        : { allowed: true },
    );
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia Alba');
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_A);
    await fire(first, 'playing');
    await act(async () => setHidden(true));
    a.duration = 200;
    a.currentTime = 185;
    a.paused = false;
    await fire(first, 'timeupdate'); // last 20 s: the continuation is prepared now
    await settle();
    expect(apiPaths()).toContain('/api/music/trending');
    expect(apiPaths()).toContain('/api/music/audius/tracks/next-1/playback');

    fetchMock.mockClear();
    mocks.apiFetch.mockClear();
    const before = play().mock.calls.length;
    await act(async () => {
      endTrack(first, a);
      // Same event: play() already called, no network request before it.
      expect(play().mock.calls.length).toBe(before + 1);
      expect(fetchPaths()).toEqual([]);
      expect(apiPaths()).toEqual([]);
      await flush();
    });
    expect(first.getAttribute('src')).toBe('/api/music/audius/tracks/next-1/stream');
    expect(text(container, 'current')).toBe('audius:next-1');
    expect(text(container, 'queue')).toBe('2');
  });
});

describe('smontaggio del player', () => {
  it('libera l’audio, la schermata di blocco e la sessione audio', async () => {
    const { container, root, first } = await mountPlayer();
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    expect(first.getAttribute('src')).toBe(STREAM_EP1);
    expect(session.metadata).not.toBeNull();
    expect(audioSession.type).toBe('playback');

    roots.splice(roots.indexOf(root), 1);
    await act(async () => root.unmount());
    expect(first.getAttribute('src')).toBeNull();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    expect(audioSession.type).toBe('auto');
  });

  it('distrugge il player ufficiale YouTube', async () => {
    const { container, root } = await mountPlayer();
    await start(container, 'Avvia video');
    await settle();
    expect(playerConstructed).toHaveBeenCalledTimes(1);
    roots.splice(roots.indexOf(root), 1);
    await act(async () => root.unmount());
    expect(yt.destroy).toHaveBeenCalled();
  });
});

describe('avanzamento: niente ridisegni a ogni timeupdate', () => {
  it('chi legge useMusicPlayer() non si ridisegna, il tempo trascorso sì', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    a.duration = 600;
    a.paused = false;
    const baseline = renders.status;
    for (let second = 1; second <= 20; second += 1) {
      a.currentTime = second;
      await fire(first, 'timeupdate');
    }
    expect(renders.status).toBe(baseline);
    expect(text(container, 'elapsed')).toBe('20');
    // The full player's time label follows the clock by itself.
    expect(
      container.querySelector('section[aria-label="Player a schermo intero"]')?.textContent,
    ).toContain('0:20');
  });

  it('la coda nascosta del player a schermo intero non ridisegna le sue copertine', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia coda lunga');
    await settle();
    await fire(first, 'playing');
    a.duration = 200;
    a.paused = false;
    const baseline = mocks.imageRenders.count;
    expect(baseline).toBeGreaterThanOrEqual(manyTracks.length);
    for (let second = 1; second <= 20; second += 1) {
      a.currentTime = second;
      await fire(first, 'timeupdate');
    }
    expect(mocks.imageRenders.count).toBe(baseline);
  });
});

describe('link verso i piani dal player', () => {
  it('«Illimitati con Premium» naviga senza ricaricare la pagina (la musica continua)', async () => {
    const { container, first } = await mountPlayer({ withRouter: true });
    await start(container, 'Avvia ep1');
    await fire(first, 'playing');
    const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
      (item) => item.textContent === 'Illimitati con Premium',
    );
    if (!link) throw new Error('Link ai piani non trovato.');
    expect(link.getAttribute('href')).toBe('/piani');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(fakeRouter.push).toHaveBeenCalledWith('/piani', '/piani', expect.anything());
  });
});
