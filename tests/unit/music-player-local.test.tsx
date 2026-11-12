// @polsia:user-owned — "La tua musica" nel player condiviso: i file dell'ascoltatore suonano da un
// object URL del Blob in IndexedDB. Nessuna richiesta al server (permessi, ascolti Free, cronologia,
// premi, accesso), nessun link "Ascolta altrove" con i loro tag, Media Session completa, salto dei
// file spariti, object URL revocati al cambio di brano e allo smontaggio, coda mista locale →
// Audius, file rimossi dal dispositivo che lasciano coda e memoria.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
  loadYouTubeIframeApi: vi.fn(),
}));

type FakeHandle = { kind: 'track' | 'artwork'; id: string; url: string; revoked: boolean };

const library = vi.hoisted(() => {
  const state = {
    files: new Set<string>(),
    covers: new Set<string>(),
    handles: [] as FakeHandle[],
    serial: 0,
  };
  const handleFor = (kind: 'track' | 'artwork', id: string) => {
    state.serial += 1;
    const handle: FakeHandle = {
      kind,
      id,
      url: `blob:http://localhost:3000/${kind}-${id}-${state.serial}`,
      revoked: false,
    };
    state.handles.push(handle);
    return {
      url: handle.url,
      revoke: () => {
        handle.revoked = true;
      },
    };
  };
  return {
    state,
    createObjectUrlForTrack: vi.fn(async (id: string) =>
      state.files.has(id) ? handleFor('track', id) : null,
    ),
    createObjectUrlForArtwork: vi.fn(async (id: string) =>
      state.covers.has(id) ? handleFor('artwork', id) : null,
    ),
    getTrack: vi.fn(async (_id: string) => null),
    setTrackDuration: vi.fn(async (_id: string, _seconds: number) => undefined),
  };
});

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/library' }));
vi.mock('@/components/custom/music/youtube-queue-player', () => ({
  loadYouTubeIframeApi: mocks.loadYouTubeIframeApi,
}));
// The player reads the library only through playback.ts (no tag readers in its bundle).
vi.mock('@/lib/local-music/playback', () => ({
  createObjectUrlForTrack: library.createObjectUrlForTrack,
  createObjectUrlForArtwork: library.createObjectUrlForArtwork,
  getTrack: library.getTrack,
  setTrackDuration: library.setTrackDuration,
}));

import {
  isLocalTrack,
  LOCAL_MISSING_MESSAGE,
  LOCAL_SOURCE_LABEL,
  localTrackToPlayerTrack,
  persistedQueueItem,
  restoreLocalItems,
} from '@/components/custom/music/local-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  recordPlay,
  requestPlayPermit,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import type { LocalTrack } from '@/lib/local-music';

function localFile(id: string, overrides: Partial<LocalTrack> = {}): LocalTrack {
  return {
    id,
    title: `Brano ${id}`,
    artist: 'Artista di casa',
    album: 'Album sul telefono',
    durationSeconds: 200,
    mimeType: 'audio/mp4',
    size: 1000,
    addedAt: 1,
    hasArtwork: true,
    ...overrides,
  };
}

const fileA = localFile('aaaa-1111', { title: 'Mattino di prova' });
const fileB = localFile('bbbb-2222', { title: 'Sera di prova', album: null });
const fileC = localFile('cccc-3333', { title: 'Notte di prova', durationSeconds: null });
const fileGone = localFile('dddd-4444', { title: 'File sparito' });
const localA = localTrackToPlayerTrack(fileA);
const localB = localTrackToPlayerTrack(fileB);
const localC = localTrackToPlayerTrack(fileC);
const localGone = localTrackToPlayerTrack(fileGone);
const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:track-x',
  title: 'Brano Audius',
  artistName: 'Artista Audius',
  sourceLabel: 'Audius',
  sourceUrl: null,
  durationSeconds: 200,
  playbackMode: 'audius',
};

const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia locali': [localA, localB],
  'Avvia senza durata': [localC],
  'Avvia mancante': [localGone, localB],
  'Avvia misto': [localA, audius],
  'Misto mancante': [localGone, audius],
  'Avvia audius': [audius],
  'Audius poi locali': [audius, localA, localB],
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
            // The Library passes '' as the stream path for its files.
            onClick={() =>
              void player.playTrack(
                first,
                first.playbackMode === 'local' ? '' : (trackStreamPath(first) ?? ''),
                queue,
              )
            }
          >
            {label}
          </button>
        );
      })}
      <button type="button" onClick={() => void player.nextTrack()}>
        Prossimo
      </button>
      <button type="button" onClick={() => player.cycleRepeat()}>
        Ripeti
      </button>
      <button type="button" onClick={() => player.forgetLocalTracks([fileA.id])}>
        Dimentica A
      </button>
      <button type="button" onClick={() => player.forgetLocalTracks([fileB.id])}>
        Dimentica B
      </button>
      <button type="button" onClick={() => player.forgetLocalTracks('all')}>
        Dimentica tutti
      </button>
      <output data-testid="status">{player.status}</output>
      <output data-testid="current">{player.currentTrack?.qualifiedId ?? ''}</output>
      <output data-testid="error">{player.errorMessage ?? ''}</output>
      <output data-testid="block">{player.playBlock ?? ''}</output>
      <output data-testid="queue">{player.queue.map((item) => item.qualifiedId).join(',')}</output>
      <output data-testid="index">{player.queueIndex}</output>
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
let fetchMock: ReturnType<typeof vi.fn>;
let handlers: Map<string, Handler>;
let session: {
  metadata: Record<string, unknown> | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** IndexedDB reads, renders and effects (the skip of a missing file runs after a render). */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) await act(flush);
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
  // Only what happens from now on counts (the access check on mount is not about local files).
  fetchMock.mockClear();
  mocks.apiFetch.mockClear();
  return { container, root, first, second, a: fakeMedia(first), b: fakeMedia(second) };
}

async function start(container: HTMLElement, label: string) {
  await act(async () => {
    button(container, label).click();
    await flush();
  });
  await settle();
}

async function fire(audio: HTMLAudioElement, type: string) {
  await act(async () => {
    audio.dispatchEvent(new Event(type));
    await flush();
  });
}

async function playedFor(audio: HTMLAudioElement, state: MediaState, seconds: number) {
  state.duration = 200;
  state.currentTime = seconds;
  state.paused = false;
  await fire(audio, 'playing');
  await fire(audio, 'timeupdate');
  await settle();
}

function endTrack(audio: HTMLAudioElement, state: MediaState) {
  state.currentTime = state.duration;
  state.paused = true;
  state.ended = true;
  audio.dispatchEvent(new Event('pause'));
  audio.dispatchEvent(new Event('ended'));
}

function handlesOf(kind: 'track' | 'artwork', id: string) {
  return library.state.handles.filter((handle) => handle.kind === kind && handle.id === id);
}

function urlOf(kind: 'track' | 'artwork', id: string) {
  const live = handlesOf(kind, id).filter((handle) => !handle.revoked);
  return live.at(-1)?.url ?? null;
}

/** Every request body sent anywhere (fetch and apiFetch), to prove local tags never leave. */
function sentBodies() {
  const bodies = [
    ...fetchMock.mock.calls.map(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? ''),
    ),
    ...mocks.apiFetch.mock.calls.map(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? ''),
    ),
  ];
  return bodies.join('\n');
}

function requestedPaths() {
  return [
    ...fetchMock.mock.calls.map(([url]) => String(url)),
    ...mocks.apiFetch.mock.calls.map(([url]) => String(url)),
  ];
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
  library.state.files = new Set([fileA.id, fileB.id, fileC.id]);
  library.state.covers = new Set([fileA.id, fileB.id]);
  library.state.handles = [];
  library.createObjectUrlForTrack.mockClear();
  library.createObjectUrlForArtwork.mockClear();
  library.setTrackDuration.mockClear();
  fetchMock = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.startsWith('/api/music/access')) return json(access);
    if (path.startsWith('/api/music/plays')) return json({ allowed: true, used: 4, limit: 40 });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  mocks.loadYouTubeIframeApi.mockReset().mockReturnValue(new Promise(() => undefined));
  handlers = new Map();
  session = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn((action: string, handler: Handler) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  Object.defineProperty(navigator, 'audioSession', {
    configurable: true,
    value: { type: 'auto' },
  });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    },
  );
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
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Reflect.deleteProperty(navigator, 'mediaSession');
  Reflect.deleteProperty(navigator, 'audioSession');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('brani locali: conversione e coda salvata', () => {
  it('un file della libreria diventa un brano "La tua musica" senza link né copertina remota', () => {
    expect(localA).toMatchObject({
      qualifiedId: `local:${fileA.id}`,
      title: 'Mattino di prova',
      artistName: 'Artista di casa',
      album: 'Album sul telefono',
      sourceLabel: LOCAL_SOURCE_LABEL,
      sourceUrl: null,
      artworkUrl: null,
      playbackMode: 'local',
    });
    expect(isLocalTrack(localA)).toBe(true);
    expect(localTrackToPlayerTrack(localFile('x-1', { artist: null })).artistName).toBe('');
    // Never fetched: a placeholder, the audio comes from an object URL.
    expect(trackStreamPath(localA)).toBe(`/local/${fileA.id}`);
    expect(trackStreamPath({ ...localA, qualifiedId: 'local:../x' })).toBeNull();
  });

  it('la coda salvata nel browser tiene dei brani locali solo l’id', () => {
    const saved = persistedQueueItem({ ...localA, artworkUrl: 'blob:http://localhost/x' });
    expect(saved).toEqual({
      qualifiedId: localA.qualifiedId,
      title: '',
      artistName: '',
      sourceLabel: LOCAL_SOURCE_LABEL,
      sourceUrl: null,
      playbackMode: 'local',
    });
    expect(JSON.stringify(saved)).not.toContain('Mattino');
    expect(persistedQueueItem(audius)).toBe(audius);
  });

  it('al ripristino rilegge i tag da IndexedDB e toglie i file spariti', async () => {
    const saved = [localGone, audius, localB].map(persistedQueueItem);
    const read = vi.fn(async (id: string) => (id === fileB.id ? fileB : null));
    // The current item (the gone file) is dropped: the item after it starts, from the beginning.
    expect(await restoreLocalItems(saved, 0, read)).toEqual({
      items: [audius, localB],
      index: 0,
      sameTrack: false,
    });
    expect(await restoreLocalItems(saved, 2, read)).toEqual({
      items: [audius, localB],
      index: 1,
      sameTrack: true,
    });
    // Library unavailable: local items leave the queue, the others stay.
    const broken = vi.fn(async () => {
      throw new Error('IndexedDB non disponibile');
    });
    expect(await restoreLocalItems(saved, 1, broken)).toEqual({
      items: [audius],
      index: 0,
      sameTrack: true,
    });
    expect(await restoreLocalItems([persistedQueueItem(localGone)], 0, read)).toBeNull();
  });
});

describe('player: brani locali', () => {
  it('suona dal dispositivo senza nessuna richiesta al server, neanche al cambio brano', async () => {
    const { container, first, second, a, b } = await mountPlayer();
    await start(container, 'Avvia locali');
    expect(first.getAttribute('src')).toBe(urlOf('track', fileA.id));
    expect(first.getAttribute('src')).toMatch(/^blob:/);
    expect(play().mock.contexts).toContain(first);
    expect(text(container, 'status')).toBe('playing');

    // Past the history threshold and with a signed-in listener: no history, rewards or plays.
    await playedFor(first, a, 60);
    // ~20 s before the end the next file is prepared on the spare deck, from IndexedDB only.
    await playedFor(first, a, 185);
    expect(second.getAttribute('src')).toBe(urlOf('track', fileB.id));
    expect(second.preload).toBe('metadata');
    expect(play().mock.contexts).not.toContain(second);

    // Gapless: the spare starts in the same 'ended' event.
    b.readyState = 1;
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    await settle();
    expect(play().mock.contexts).toContain(second);
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    expect(text(container, 'status')).toBe('playing');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Ascolti gratuiti');
  });

  it('non chiede l’accesso: un ospite ascolta i suoi file e la coda avanza senza blocchi', async () => {
    access = { premium: false, signedIn: false, playsUsed: 40, playsLimit: 40 };
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia locali');
    expect(text(container, 'status')).toBe('playing');
    expect(text(container, 'block')).toBe('');
    await playedFor(first, a, 190);
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    await settle();
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    expect(text(container, 'block')).toBe('');
    expect(container.textContent).not.toContain('Registrati');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Media Session: titolo, artista, album e copertina del file; precedente, successivo e seek', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia locali');
    expect(session.metadata).toMatchObject({
      title: 'Mattino di prova',
      artist: 'Artista di casa',
      album: 'Album sul telefono',
      artwork: [{ src: urlOf('artwork', fileA.id) }],
    });
    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']) {
      expect(handlers.get(action), action).toBeTypeOf('function');
    }

    await playedFor(first, a, 30);
    await act(async () => {
      handlers.get('seekto')?.({ action: 'seekto', seekTime: 90 });
      await flush();
    });
    expect(a.currentTime).toBe(90);

    await act(async () => {
      handlers.get('nexttrack')?.({ action: 'nexttrack' });
      await flush();
    });
    await settle();
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    // No album tag: the source name stands in on the lock screen.
    expect(session.metadata).toMatchObject({
      title: 'Sera di prova',
      album: LOCAL_SOURCE_LABEL,
      artwork: [{ src: urlOf('artwork', fileB.id) }],
    });

    await act(async () => {
      handlers.get('previoustrack')?.({ action: 'previoustrack' });
      await flush();
    });
    await settle();
    expect(text(container, 'current')).toBe(localA.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un file non più sul dispositivo: messaggio in italiano e passa al successivo', async () => {
    const { container, first } = await mountPlayer();
    await start(container, 'Avvia mancante');
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    expect(first.getAttribute('src')).toBe(urlOf('track', fileB.id));
    expect(text(container, 'error')).toBe(LOCAL_MISSING_MESSAGE);
    expect(container.querySelector('aside[data-solco-player]')?.textContent).toContain(
      'Il file non è più su questo dispositivo: aggiungilo di nuovo da La tua musica.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un file sparito mentre suonava: lo dice e passa al successivo', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia locali');
    a.currentTime = 12;
    library.state.files.delete(fileA.id);
    await fire(first, 'error');
    await settle();
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    expect(text(container, 'error')).toBe(LOCAL_MISSING_MESSAGE);
    expect(first.getAttribute('src')).toBe(urlOf('track', fileB.id));
  });

  it('revoca gli object URL al cambio di brano e allo smontaggio, mai subito dopo play()', async () => {
    const { container, root, first, a } = await mountPlayer();
    await start(container, 'Avvia locali');
    await playedFor(first, a, 20);
    expect(handlesOf('track', fileA.id).map((handle) => handle.revoked)).toEqual([false]);
    expect(handlesOf('artwork', fileA.id).map((handle) => handle.revoked)).toEqual([false]);

    await act(async () => {
      button(container, 'Prossimo').click();
      await flush();
    });
    await settle();
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    expect(handlesOf('track', fileA.id).every((handle) => handle.revoked)).toBe(true);
    expect(handlesOf('artwork', fileA.id).every((handle) => handle.revoked)).toBe(true);
    expect(handlesOf('track', fileB.id).map((handle) => handle.revoked)).toEqual([false]);
    expect(handlesOf('artwork', fileB.id).map((handle) => handle.revoked)).toEqual([false]);

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(library.state.handles.every((handle) => handle.revoked)).toBe(true);
  });

  it('chiudendo il player revoca tutto', async () => {
    const { container } = await mountPlayer();
    await start(container, 'Avvia locali');
    await act(async () => {
      button(container, 'Chiudi il player').click();
      await flush();
    });
    expect(library.state.handles.length).toBeGreaterThan(0);
    expect(library.state.handles.every((handle) => handle.revoked)).toBe(true);
  });

  it('salva la durata nella libreria quando il file non ne aveva una', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia senza durata');
    a.duration = 124.11;
    await fire(first, 'loadedmetadata');
    await fire(first, 'timeupdate');
    expect(library.setTrackDuration).toHaveBeenCalledTimes(1);
    expect(library.setTrackDuration).toHaveBeenCalledWith(fileC.id, 124.11);

    // A file that already has one is left alone.
    library.setTrackDuration.mockClear();
    await start(container, 'Avvia locali');
    await playedFor(first, a, 10);
    expect(library.setTrackDuration).not.toHaveBeenCalled();
  });

  it('nessuna azione playlist o Preferiti e niente "Ascolta altrove" per un file locale', async () => {
    const { container } = await mountPlayer();
    await start(container, 'Avvia locali');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label^="Apri il player"]')?.click();
    });
    const full = document.querySelector('section[aria-label="Player a schermo intero"]');
    expect(full?.hasAttribute('hidden')).toBe(false);
    const controls = [...document.querySelectorAll('button, a')].map(
      (item) => `${item.textContent ?? ''} ${item.getAttribute('aria-label') ?? ''}`,
    );
    expect(controls.some((label) => /playlist|preferit/i.test(label))).toBe(false);
    expect(full?.textContent).toContain('La tua musica');
    // Its search links would carry the file's title and artist to five other services.
    expect(full?.textContent).not.toContain('Ascolta altrove');
    expect(full?.querySelectorAll('a[href]')).toHaveLength(0);
    expect(full?.querySelector('img')?.getAttribute('src')).toBe(urlOf('artwork', fileA.id));

    // A streamed track keeps the menu.
    await start(container, 'Avvia audius');
    expect(text(container, 'current')).toBe(audius.qualifiedId);
    expect(
      document.querySelector('section[aria-label="Player a schermo intero"]')?.textContent,
    ).toContain('Ascolta altrove');
  });

  it('coda mista: il file locale non chiede nulla, il brano Audius dopo chiede il permesso', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia misto');
    expect(text(container, 'status')).toBe('playing');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    await playedFor(first, a, 40);

    await act(async () => {
      button(container, 'Prossimo').click();
      await flush();
    });
    await settle();
    expect(text(container, 'current')).toBe(audius.qualifiedId);
    expect(first.getAttribute('src')).toBe('/api/music/audius/tracks/track-x/stream');

    const plays = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/music/plays');
    expect(plays).toHaveLength(1);
    expect(JSON.parse(String((plays[0]?.[1] as RequestInit).body))).toEqual({
      qualifiedId: audius.qualifiedId,
    });
    expect(requestedPaths()).toContain('/api/music/audius/tracks/track-x/playback');
    // Nothing sent anywhere names the local file.
    expect(requestedPaths().some((path) => path.includes('local'))).toBe(false);
    expect(sentBodies()).not.toMatch(/local:|Mattino|Artista di casa|Album sul telefono/);
  });
});

describe('player: brani locali e servizi di Solco', () => {
  it('recordPlay e il permesso di ascolto non mandano nulla per un file locale', async () => {
    fetchMock.mockClear();
    mocks.apiFetch.mockClear();
    recordPlay(localA);
    recordPlay({ ...localA, playbackMode: undefined });
    expect(await requestPlayPermit(localA.qualifiedId)).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    // Control: a streamed track is recorded and asks for its permit.
    recordPlay(audius);
    await requestPlayPermit(audius.qualifiedId);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/music/plays']);
  });

  /** One second of media per second of wall clock, so listening time really accrues. */
  async function listenFor(label: string, seconds: number) {
    let wall = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const { container, first, a } = await mountPlayer();
    await start(container, label);
    a.duration = 600;
    a.paused = false;
    await fire(first, 'playing');
    for (let second = 0; second <= seconds; second += 1) {
      a.currentTime = second;
      wall += 1000;
      await act(async () => {
        first.dispatchEvent(new Event('timeupdate'));
      });
    }
    await settle();
    return fetchMock.mock.calls.filter(([url]) => String(url) === '/api/rewards');
  }

  it('premi: un ospite registrato che ascolta un brano Audius per 130 s manda i minuti', async () => {
    const ticks = await listenFor('Avvia audius', 130);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it('premi: 130 s di un file locale non mandano nessun minuto né altro', async () => {
    const ticks = await listenFor('Avvia locali', 130);
    expect(ticks).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe('player: file mancanti e file rimossi', () => {
  it('un brano che suona fa ripartire il conteggio dei file mancanti (nuova coda dalla Libreria)', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Misto mancante');
    expect(text(container, 'current')).toBe(audius.qualifiedId);
    await playedFor(first, a, 40);
    expect(text(container, 'status')).toBe('playing');

    await start(container, 'Avvia mancante');
    expect(text(container, 'current')).toBe(localB.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    expect(first.getAttribute('src')).toBe(urlOf('track', fileB.id));
  });

  it('un file rimosso mentre è pronto sulla riserva non suona più: via dalla coda e dalla memoria', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia locali');
    await playedFor(first, a, 185);
    expect(second.getAttribute('src')).toBe(urlOf('track', fileB.id));

    await act(async () => {
      button(container, 'Dimentica B').click();
      await flush();
    });
    expect(second.getAttribute('src')).toBeNull();
    expect(handlesOf('track', fileB.id).every((handle) => handle.revoked)).toBe(true);
    expect(text(container, 'queue')).toBe(localA.qualifiedId);
    expect(text(container, 'current')).toBe(localA.qualifiedId);
    expect(text(container, 'status')).toBe('playing');

    library.createObjectUrlForTrack.mockClear();
    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    await settle();
    expect(play().mock.contexts).not.toContain(second);
    expect(library.createObjectUrlForTrack).not.toHaveBeenCalled();
    expect(text(container, 'current')).toBe(localA.qualifiedId);
  });

  it('rimuovere il file che suona ferma il player e revoca tutto', async () => {
    const { container } = await mountPlayer();
    await start(container, 'Avvia locali');
    await act(async () => {
      button(container, 'Dimentica A').click();
      await flush();
    });
    expect(text(container, 'current')).toBe('');
    expect(text(container, 'status')).toBe('idle');
    expect(text(container, 'queue')).toBe('');
    expect(library.state.handles.every((handle) => handle.revoked)).toBe(true);
  });

  it('«Rimuovi tutti» toglie i file locali dalla coda, il brano Audius continua', async () => {
    const { container, first } = await mountPlayer();
    await start(container, 'Audius poi locali');
    expect(text(container, 'current')).toBe(audius.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    await act(async () => {
      button(container, 'Dimentica tutti').click();
      await flush();
    });
    expect(text(container, 'queue')).toBe(audius.qualifiedId);
    expect(text(container, 'index')).toBe('0');
    expect(text(container, 'current')).toBe(audius.qualifiedId);
    expect(text(container, 'status')).toBe('playing');
    expect(first.getAttribute('src')).toBe('/api/music/audius/tracks/track-x/stream');
  });

  it('con "ripeti brano" non prepara il file successivo', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia locali');
    await act(async () => {
      button(container, 'Ripeti').click();
    });
    await act(async () => {
      button(container, 'Ripeti').click();
    });
    library.createObjectUrlForTrack.mockClear();
    await playedFor(first, a, 185);
    expect(library.createObjectUrlForTrack).not.toHaveBeenCalled();
    expect(second.getAttribute('src')).toBeNull();
  });
});
