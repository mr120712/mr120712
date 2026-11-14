// @polsia:user-owned — ascolto in background: passaggio sincrono a fine brano, YouTube mai a
// pagina nascosta, controlli di sistema per tipo di contenuto, sessione audio, premi.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
  loadYouTubeIframeApi: vi.fn(),
  playerCreated: vi.fn(),
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
import { setPlaybackSpeed } from '@/lib/music/playback-speed';

const audiusA: MusicPlayerTrack = {
  qualifiedId: 'audius:track-a',
  title: 'Alba',
  artistName: 'Artista Uno',
  artworkUrl: 'https://creatornode.audius.co/content/Qm/480x480.jpg',
  sourceLabel: 'Audius',
  sourceUrl: null,
  durationSeconds: 200,
  playbackMode: 'audius',
};
const audiusB: MusicPlayerTrack = {
  ...audiusA,
  qualifiedId: 'audius:track-b',
  title: 'Brezza',
  artworkUrl: null,
};
const video: MusicPlayerTrack = {
  qualifiedId: 'youtube:aaaaaaaaaaa',
  title: 'Video in coda',
  artistName: 'Canale',
  sourceLabel: 'YouTube',
  sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  playbackMode: 'youtube',
};
const episode1: MusicPlayerTrack = {
  qualifiedId: 'podcast:123~ep1',
  title: 'Episodio 1',
  artistName: 'Show',
  sourceLabel: 'Podcast',
  sourceUrl: null,
  durationSeconds: 600,
  playbackMode: 'podcast',
};
const episode2: MusicPlayerTrack = {
  ...episode1,
  qualifiedId: 'podcast:123~ep2',
  title: 'Episodio 2',
};
const station: MusicPlayerTrack = {
  qualifiedId: 'radio:station-1',
  title: 'Radio Prova',
  artistName: 'Italia',
  sourceLabel: 'Radio dal vivo',
  sourceUrl: null,
  playbackMode: 'radio',
};

const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia Audius': [audiusA, audiusB],
  'Avvia misto': [audiusA, video],
  'Avvia podcast': [episode1, episode2],
  'Avvia radio': [station],
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
      <button type="button" onClick={() => player.primeAudio()}>
        Prepara audio
      </button>
      <output data-testid="status">{player.status}</output>
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
};

const roots: Array<ReturnType<typeof createRoot>> = [];
let access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
let playsResponse: () => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
let handlers: Map<string, Handler>;
let session: {
  metadata: { title?: string; artwork?: unknown } | null;
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
  return state;
}

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
  const audio = container.querySelector('audio');
  if (!audio) throw new Error('audio mancante');
  return { container, audio, state: fakeMedia(audio) };
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

function status(container: HTMLElement) {
  return container.querySelector('[data-testid="status"]')?.textContent;
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
  mocks.playerCreated.mockReset();
  mocks.loadYouTubeIframeApi.mockReset().mockResolvedValue({
    Player: function Player(_element: HTMLElement, options: unknown) {
      mocks.playerCreated(options);
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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  try {
    window.localStorage.clear();
  } catch {
    // ignora
  }
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Reflect.deleteProperty(navigator, 'mediaSession');
  Reflect.deleteProperty(navigator, 'audioSession');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('fine brano con Solco nascosto (schermo bloccato)', () => {
  it('prepara il successivo senza consumare ascolti e a fine brano cambia src nello stesso evento', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia Audius');
    expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-a/stream');
    expect(fetchPaths().filter((path) => path === '/api/music/plays')).toHaveLength(1);

    // 15 seconds before the end: rights of B checked with GET …/playback (never a play).
    state.duration = 200;
    state.currentTime = 185;
    state.paused = false;
    await fire(audio, 'timeupdate');
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/music/audius/tracks/track-b/playback',
      expect.anything(),
    );
    expect(fetchPaths().filter((path) => path === '/api/music/plays')).toHaveLength(1);
    expect(fetchPaths().some((path) => path.includes('/stream'))).toBe(false);

    await act(async () => setHidden(true));
    const apiCalls = mocks.apiFetch.mock.calls.length;
    const fetchCalls = fetchMock.mock.calls.length;
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    session.playbackState = 'paused';

    await act(async () => {
      state.currentTime = 200;
      state.paused = true;
      state.ended = true;
      // HTML spec order at the end of a resource: 'pause' then 'ended'.
      audio.dispatchEvent(new Event('pause'));
      audio.dispatchEvent(new Event('ended'));
      // Same task as 'ended': no await, no network round trip before play().
      expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-b/stream');
      expect(play).toHaveBeenCalledTimes(1);
      expect(session.metadata?.title).toBe('Brezza');
      expect(session.playbackState).toBe('playing');
      expect(audioSession.type).toBe('playback');
      expect(mocks.apiFetch.mock.calls.length).toBe(apiCalls);
      expect(fetchMock.mock.calls.length).toBe(fetchCalls);
      await flush();
    });
    expect(container.textContent).toContain('Brezza');

    // The stream request counts the play server-side: no POST /plays (no double count); the
    // counter is refreshed with GET /api/music/access once audio flows.
    state.ended = false;
    state.paused = false;
    state.currentTime = 0;
    const before = fetchMock.mock.calls.length;
    await fire(audio, 'playing');
    const after = fetchPaths().slice(before);
    expect(after).toContain('/api/music/access');
    expect(after).not.toContain('/api/music/plays');
    expect(status(container)).toBe('playing');
  });

  it('salta un video YouTube in coda e, se non c’è altro audio, lo rimanda al ritorno su Solco', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia misto');
    await act(async () => setHidden(true));
    state.ended = true;
    await fire(audio, 'ended');

    expect(container.textContent).toContain('Il prossimo è un video YouTube');
    expect(status(container)).toBe('paused');
    expect(mocks.loadYouTubeIframeApi).not.toHaveBeenCalled();
    expect(mocks.playerCreated).not.toHaveBeenCalled();
    // The lock-screen play button cannot start it either.
    await act(async () => {
      handlers.get('play')?.({ action: 'play' });
      await flush();
    });
    expect(mocks.playerCreated).not.toHaveBeenCalled();

    await act(async () => {
      setHidden(false);
      await flush();
    });
    await act(flush);
    expect(mocks.playerCreated).toHaveBeenCalledTimes(1);
  });

  it('mette in pausa un video che parte mentre Solco è nascosto', async () => {
    let events: { onStateChange: (event: { data: number }) => void } | null = null;
    const pauseVideo = vi.fn();
    mocks.loadYouTubeIframeApi.mockResolvedValue({
      Player: function Player(_el: HTMLElement, options: { events: typeof events }) {
        events = options.events;
        return {
          loadVideoById: vi.fn(),
          playVideo: vi.fn(),
          pauseVideo,
          seekTo: vi.fn(),
          getCurrentTime: () => 0,
          getDuration: () => 0,
          destroy: vi.fn(),
        };
      },
    });
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia misto');
    state.ended = true;
    await fire(audio, 'ended');
    await act(flush);
    expect(events).not.toBeNull();

    await act(async () => setHidden(true));
    pauseVideo.mockClear();
    await act(async () => events?.onStateChange({ data: 1 }));
    expect(pauseVideo).toHaveBeenCalled();
    expect(status(container)).toBe('paused');
  });

  it('prevede il limite Free a fine brano e mostra l’invito senza richiedere lo stream', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia podcast');
    access = { premium: false, signedIn: true, playsUsed: 40, playsLimit: 40 };
    state.duration = 600;
    state.currentTime = 590;
    await fire(audio, 'timeupdate');
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    state.ended = true;
    await fire(audio, 'ended');
    expect(play).not.toHaveBeenCalled();
    expect(audio.getAttribute('src')).toBeNull();
    expect(container.textContent).toContain('Hai usato i 40 ascolti gratuiti di questo mese.');
  });

  it('ripeti brano: l’elemento va in loop e non arriva mai a "ended"', async () => {
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia Audius');
    expect(audio.loop).toBe(false);
    await act(async () => button(container, 'Ripeti: disattivato').click());
    await act(async () => button(container, 'Ripeti: tutta la coda').click());
    expect(audio.loop).toBe(true);
  });
});

describe('controlli di sistema (schermata di blocco, notifica, cuffie)', () => {
  it('musica: precedente/successivo; i salti ±secondi sono azzerati esplicitamente', async () => {
    const { container } = await mountPlayer();
    await start(container, 'Avvia Audius');
    expect(typeof handlers.get('previoustrack')).toBe('function');
    expect(typeof handlers.get('nexttrack')).toBe('function');
    expect(typeof handlers.get('seekto')).toBe('function');
    expect(session.setActionHandler).toHaveBeenCalledWith('seekbackward', null);
    expect(session.setActionHandler).toHaveBeenCalledWith('seekforward', null);
    expect(handlers.get('seekbackward')).toBeNull();
    expect(handlers.get('seekforward')).toBeNull();
    expect(session.metadata?.artwork).toEqual([
      { src: audiusA.artworkUrl, sizes: '480x480', type: 'image/jpeg' },
    ]);
  });

  it('podcast: indietro 15 s e avanti 30 s, senza cambio episodio', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia podcast');
    expect(handlers.get('previoustrack')).toBeNull();
    expect(handlers.get('nexttrack')).toBeNull();
    state.duration = 600;
    state.currentTime = 100;
    await act(async () => handlers.get('seekbackward')?.({ action: 'seekbackward' }));
    expect(audio.currentTime).toBe(85);
    await act(async () => handlers.get('seekforward')?.({ action: 'seekforward' }));
    expect(audio.currentTime).toBe(115);
    await act(async () => handlers.get('seekto')?.({ action: 'seekto', seekTime: 300 }));
    expect(audio.currentTime).toBe(300);
  });

  it('radio in diretta: nessun cursore né salto', async () => {
    const { container } = await mountPlayer();
    await start(container, 'Avvia radio');
    for (const action of ['seekto', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack']) {
      expect(handlers.get(action)).toBeNull();
    }
    expect(typeof handlers.get('pause')).toBe('function');
  });

  it('play da schermata di blocco: play() subito, verifica dell’accesso in parallelo', async () => {
    const { container } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    expect(status(container)).toBe('paused');
    expect(session.playbackState).toBe('paused');

    let answer: (value: unknown) => void = () => undefined;
    mocks.apiFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    await act(async () => {
      handlers.get('play')?.({ action: 'play' });
      expect(play).toHaveBeenCalledTimes(1);
      await flush();
    });
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/music/audius/tracks/track-a/playback',
      expect.anything(),
    );
    await act(async () => {
      answer({ allowed: true });
      await flush();
    });
    expect(status(container)).toBe('playing');
  });

  it('play da schermata di blocco con rete assente o verifica temporanea: continua a suonare', async () => {
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia Audius');
    for (const failure of [
      new TypeError('Failed to fetch'),
      new Error('apiFetch failed (429)', { cause: { error: 'rate_limited' } }),
      new Error('apiFetch failed (503)', {
        cause: { allowed: false, reason: 'entitlement_unavailable' },
      }),
    ]) {
      await act(async () => handlers.get('pause')?.({ action: 'pause' }));
      mocks.apiFetch.mockRejectedValueOnce(failure);
      await act(async () => {
        handlers.get('play')?.({ action: 'play' });
        await flush();
      });
      expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-a/stream');
      expect(status(container)).toBe('playing');
      expect(container.textContent).not.toContain('Nessun audio');
    }
  });

  it('play da schermata di blocco con accesso revocato: ferma l’audio e spiega perché', async () => {
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia Audius');
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    mocks.apiFetch.mockRejectedValueOnce(
      new Error('apiFetch failed (403)', { cause: { allowed: false, reason: 'pro_required' } }),
    );
    await act(async () => {
      handlers.get('play')?.({ action: 'play' });
      await flush();
    });
    expect(audio.getAttribute('src')).toBeNull();
    expect(status(container)).toBe('error');
    expect(container.textContent).toContain('richiede un abbonamento Solco Pro attivo');
  });

  it('passaggio automatico rifiutato da iOS: Now Playing torna in pausa', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia Audius');
    state.duration = 200;
    state.currentTime = 185;
    state.paused = false;
    await fire(audio, 'timeupdate');
    await act(async () => setHidden(true));
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('Richiede un gesto', 'NotAllowedError'),
    );
    await act(async () => {
      state.currentTime = 200;
      state.paused = true;
      state.ended = true;
      audio.dispatchEvent(new Event('pause'));
      audio.dispatchEvent(new Event('ended'));
      await flush();
    });
    expect(audio.getAttribute('src')).toBe('/api/music/audius/tracks/track-b/stream');
    expect(status(container)).toBe('paused');
    expect(session.playbackState).toBe('paused');
  });

  it('pausa durante il caricamento: si ferma e non riparte da sola', async () => {
    let release: (value: Response) => void = () => undefined;
    playsResponse = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia Audius');
    expect(status(container)).toBe('loading');
    await act(async () => handlers.get('pause')?.({ action: 'pause' }));
    expect(status(container)).toBe('paused');
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    await act(async () => {
      release(json({ allowed: true, used: 4, limit: 40 }));
      await flush();
    });
    expect(play).not.toHaveBeenCalled();
    expect(audio.getAttribute('src')).toBeNull();
    expect(status(container)).toBe('paused');
  });

  it('il cursore di sistema segue gli eventi dell’elemento, non ogni timeupdate', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia Audius');
    state.duration = 200;
    state.currentTime = 0;
    // La velocità viene dallo store "slowed/sped up": sceglila e l'elemento la assume al loadedmetadata.
    await act(async () => setPlaybackSpeed(1.25));
    await fire(audio, 'loadedmetadata');
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 200,
      position: 0,
      playbackRate: 1.25,
    });
    session.setPositionState.mockClear();
    for (const time of [1, 2, 3]) {
      state.currentTime = time;
      await fire(audio, 'timeupdate');
    }
    expect(session.setPositionState).not.toHaveBeenCalled();
    state.currentTime = 50;
    await fire(audio, 'seeked');
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 200,
      position: 50,
      playbackRate: 1.25,
    });
  });

  it('per la radio azzera il cursore invece di passare una durata infinita', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia radio');
    state.duration = Number.POSITIVE_INFINITY;
    state.currentTime = 12;
    session.setPositionState.mockClear();
    await fire(audio, 'loadedmetadata');
    expect(session.setPositionState).toHaveBeenCalledWith();
    for (const call of session.setPositionState.mock.calls) {
      expect(call[0]?.duration).not.toBe(Number.POSITIVE_INFINITY);
    }
  });
});

describe('sessione audio e riconnessioni', () => {
  it('dichiara la sessione playback quando parte l’audio e la rilascia alla chiusura', async () => {
    const { container } = await mountPlayer();
    expect(audioSession.type).toBe('auto');
    await start(container, 'Avvia Audius');
    expect(audioSession.type).toBe('playback');
    await act(async () => button(container, 'Chiudi il player').click());
    expect(audioSession.type).toBe('auto');
    expect(session.playbackState).toBe('none');
  });

  it('primeAudio sblocca i due elementi audio dentro il tocco senza dichiarare la sessione', async () => {
    const { container } = await mountPlayer();
    const load = vi.mocked(HTMLMediaElement.prototype.load);
    load.mockClear();
    act(() => button(container, 'Prepara audio').click());
    // One load() per deck (active + spare for the gapless advance), synchronously in the tap.
    expect(load.mock.contexts).toEqual([...container.querySelectorAll('audio')]);
    // Nothing found yet (the YouTube video may go on): 'playback' only right before play().
    expect(audioSession.type).toBe('auto');
  });

  it('radio: chiudere il player annulla la riconnessione a tempo', async () => {
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia radio');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    // 1st error: immediate restart; 2nd error: retry scheduled with a timer.
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });
    expect(status(container)).toBe('loading');
    act(() => button(container, 'Chiudi il player').click());
    play.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();
    expect(audio.getAttribute('src')).toBeNull();
    expect(container.querySelector('[data-solco-player]')).toBeNull();
  });

  it('radio: pausa durante la riconnessione a tempo, nessuna ripartenza da sola', async () => {
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia radio');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });
    act(() => handlers.get('pause')?.({ action: 'pause' }));
    play.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();
    expect(status(container)).toBe('paused');
  });

  it('riavvio dello stream rifiutato da iOS (NotAllowedError): in pausa, play di nuovo attivo', async () => {
    const { container, audio } = await mountPlayer();
    await start(container, 'Avvia radio');
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('Richiede un gesto', 'NotAllowedError'),
    );
    await fire(audio, 'error');
    expect(status(container)).toBe('paused');
    expect(session.playbackState).toBe('paused');
    expect(button(container, 'Riproduci Radio Prova').disabled).toBe(false);
  });

  it('radio: la prima riconnessione avviene nell’evento di errore, senza timer', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia radio');
    state.currentTime = 30;
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    const timer = vi.spyOn(window, 'setTimeout');
    await act(async () => {
      audio.dispatchEvent(new Event('error'));
      expect(play).toHaveBeenCalledTimes(1);
      expect(timer).not.toHaveBeenCalled();
    });
    expect(audio.getAttribute('src')).toBe('/api/music/radio/station-1/stream');
  });

  it('podcast: un’interruzione di rete riprende dallo stesso punto', async () => {
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia podcast');
    state.duration = 600;
    state.currentTime = 120;
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    await fire(audio, 'error');
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute('src')).toBe('/api/music/podcasts/123/episodes/ep1/stream');
    state.currentTime = 0;
    await fire(audio, 'loadedmetadata');
    expect(audio.currentTime).toBe(120);
    expect(container.textContent).not.toContain('non è disponibile');
  });
});

describe('tempo di ascolto per i premi', () => {
  it('conta i secondi riprodotti e invia un minuto con keepalive, anche a pagina nascosta', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { container, audio, state } = await mountPlayer();
    await start(container, 'Avvia podcast');
    await act(async () => setHidden(true));
    state.duration = 600;
    state.paused = false;
    for (let second = 0; second <= 62; second += 2) {
      now = 1_000_000 + second * 1000;
      state.currentTime = second;
      await fire(audio, 'timeupdate');
    }
    const rewards = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/rewards');
    expect(rewards).toHaveLength(1);
    const init = rewards[0]?.[1] as RequestInit;
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ action: 'listen', seconds: 60 });
  });
});
