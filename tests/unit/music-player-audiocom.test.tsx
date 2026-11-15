// @polsia:user-owned — brani di audio.com nel player di Solco: account obbligatorio e conteggio nei
// 40 ascolti Free. Il player chiede il permesso (POST /api/music/plays, che per audiocom:<id>
// registra l'ascolto) PRIMA di far partire lo stream https di audio.com: un ospite vede l'invito ad
// accedere e non sente nulla, oltre il limite compare l'invito a Premium, un permesso non
// confermato non fa partire nulla. A fine brano il passaggio sincrono manda il permesso insieme
// all'audio e la riserva non precarica mai audio.com. Gli id storici upload:audiocom~<id> (anche
// nella coda salvata nel browser) valgono come audiocom:<id>. Gli upload pubblici non cambiano.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: unknown): Promise<unknown> => ({ allowed: true })),
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

import { audioComToPlayerTrack } from '@/components/custom/music/audiocom-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import { PLAY_PERMIT_UNCONFIRMED_MESSAGE } from '@/lib/music/player-messages';
import { PLAYER_STORAGE_KEY } from '@/lib/music/player-session';

const STREAM_111 = 'https://s3.audio.com/audio/111.mp3';
const STREAM_222 = 'https://s3.audio.com/audio/222.mp3';

function audioCom(id: string, title: string): MusicPlayerTrack {
  const item: AudioComTrack = {
    id,
    title,
    authorName: 'Anna Rossi',
    pageUrl: `https://audio.com/anna-rossi/audio/brano-${id}`,
    imageUrl: null,
    streamUrl: `https://s3.audio.com/audio/${id}.mp3`,
    durationSeconds: 200,
    category: 'music',
    license: 'cc-by',
  };
  const track = audioComToPlayerTrack(item);
  if (!track) throw new Error('brano di audio.com non riproducibile');
  return track;
}

const alba = audioCom('111', 'Alba sul mare');
const brezza = audioCom('222', 'Brezza');
/** Come era salvato prima del cambio: stessa forma, id della via dei file pubblici. */
const legacyAlba: MusicPlayerTrack = { ...alba, qualifiedId: 'upload:audiocom~111' };
const publicUpload: MusicPlayerTrack = {
  qualifiedId: `upload:${'c'.repeat(25)}`,
  title: 'Brano caricato',
  artistName: 'Io',
  sourceLabel: 'Libreria pubblica',
  sourceUrl: null,
  streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3',
  durationSeconds: 100,
  playbackMode: 'upload',
};

const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia audio.com': [alba, brezza],
  'Avvia id storico': [legacyAlba],
  'Avvia upload': [publicUpload],
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
      <output data-testid="current">{player.currentTrack?.qualifiedId ?? ''}</output>
      <output data-testid="error">{player.errorMessage ?? ''}</output>
      <output data-testid="block">{player.playBlock ?? ''}</output>
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

const roots: Array<ReturnType<typeof createRoot>> = [];
const states = new WeakMap<HTMLMediaElement, MediaState>();
let access: Record<string, unknown> | null;
let playsResponse: (qualifiedId: string) => Promise<Response>;
let permits: string[];
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  const [first, second] = [...container.querySelectorAll('audio')] as [
    HTMLAudioElement,
    HTMLAudioElement,
  ];
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

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await flush();
  });
}

/** HTML order at the end of a resource: 'pause' then 'ended', in one task. */
function endTrack(audio: HTMLAudioElement, state: MediaState) {
  state.currentTime = Number.isFinite(state.duration) ? state.duration : state.currentTime;
  state.paused = true;
  state.ended = true;
  audio.dispatchEvent(new Event('pause'));
  audio.dispatchEvent(new Event('ended'));
}

/** 15 s before the end of a 200 s track: the player prepares the next item. */
async function nearEnd(audio: HTMLAudioElement, state: MediaState) {
  state.duration = 200;
  state.currentTime = 185;
  state.paused = false;
  await fire(audio, 'timeupdate');
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  auth.state = { data: { user: { id: 'u1' } }, isPending: false };
  access = { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 };
  playsResponse = async () => json({ allowed: true, used: 4, limit: 40 });
  permits = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('/api/music/access')) {
      return access ? json(access) : json({ error: 'unavailable' }, 500);
    }
    if (path.startsWith('/api/music/plays')) {
      const { qualifiedId } = JSON.parse(String(init?.body ?? '{}')) as { qualifiedId: string };
      permits.push(qualifiedId);
      return playsResponse(qualifiedId);
    }
    if (path.startsWith('/api/rewards')) return json({ counted: true });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler: vi.fn(),
      setPositionState: vi.fn(),
    },
  });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    },
  );
  // Fake engine: play() makes the element audible, pause() and load() silence it.
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
  try {
    window.localStorage.clear();
  } catch {
    // ignora
  }
  Reflect.deleteProperty(navigator, 'mediaSession');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
});

describe('brano di audio.com: il permesso prima dell’audio', () => {
  it('chiede /api/music/plays con audiocom:<id> e suona dallo stream di audio.com solo dopo il sì', async () => {
    const answer = deferred<Response>();
    playsResponse = () => answer.promise;
    const { container, first, second } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia audio.com');
    expect(permits).toEqual(['audiocom:111']);
    // Nessun byte da audio.com prima della risposta: né sorgente né play().
    expect(first.getAttribute('src')).toBeNull();
    expect(second.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'status')).toBe('loading');

    await act(async () => {
      answer.resolve(json({ allowed: true, used: 4, limit: 40 }));
      await flush();
    });
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_111);
    expect(play()).toHaveBeenCalledTimes(1);
    expect(text(container, 'current')).toBe('audiocom:111');
    expect(text(container, 'block')).toBe('');
    // Un solo permesso per l'avvio (registra l'ascolto una volta).
    expect(permits).toEqual(['audiocom:111']);
    // Conta nei 40 ascolti Free: il player mostra il contatore aggiornato dal permesso.
    expect(container.textContent).toContain('Ascolti gratuiti questo mese: 4 di 40.');
    // L'attribuzione CC resta nella riga della fonte.
    expect(container.textContent).toContain('audio.com · CC BY 4.0');
  });

  it('ospite: invito ad accedere e nessun audio da audio.com', async () => {
    auth.state = { data: null, isPending: false };
    access = { premium: false, signedIn: false, playsUsed: null, playsLimit: 40 };
    playsResponse = async () =>
      json({ allowed: false, reason: 'login_required', used: 0, limit: 40 }, 401);
    const { container, first, second } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia audio.com');
    await settle();
    expect(permits).toEqual(['audiocom:111']);
    expect(first.getAttribute('src')).toBeNull();
    expect(second.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'status')).toBe('idle');
    expect(text(container, 'block')).toBe('login_required');
    expect(container.textContent).toContain('Per ascoltare serve un account gratuito.');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();

    // Play di nuovo: stesso permesso, stesso invito, ancora nessun audio.
    await act(async () => {
      button(container, 'Riproduci Alba sul mare').click();
      await flush();
    });
    await settle();
    expect(permits).toEqual(['audiocom:111', 'audiocom:111']);
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
  });

  it('oltre i 40 ascolti del mese: invito a Premium e nessun audio', async () => {
    playsResponse = async () =>
      json({ allowed: false, reason: 'monthly_limit', used: 40, limit: 40 }, 402);
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia audio.com');
    await settle();
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'block')).toBe('monthly_limit');
    expect(container.textContent).toContain('Hai usato i 40 ascolti gratuiti di questo mese.');
    expect(container.querySelector('a[href="/piani"]')).not.toBeNull();
  });

  it('permesso non confermato (registro non disponibile, rete giù): nessun audio e il motivo', async () => {
    playsResponse = async () => json({ error: 'play_unavailable' }, 503);
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia audio.com');
    await settle();
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'status')).toBe('error');
    expect(text(container, 'error')).toBe(PLAY_PERMIT_UNCONFIRMED_MESSAGE);
    expect(text(container, 'block')).toBe('');

    playsResponse = () => Promise.reject(new TypeError('Failed to fetch'));
    await start(container, 'Avvia audio.com');
    await settle();
    expect(permits).toEqual(['audiocom:111', 'audiocom:111']);
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'error')).toBe(PLAY_PERMIT_UNCONFIRMED_MESSAGE);
  });

  it('Premium: suona dallo stream di audio.com, senza contatore', async () => {
    access = { premium: true, signedIn: true, playsUsed: 0, playsLimit: null };
    playsResponse = async () => json({ allowed: true, used: 0, limit: null });
    const { container, first } = await mountPlayer();

    await start(container, 'Avvia audio.com');
    await settle();
    expect(permits).toEqual(['audiocom:111']);
    expect(first.getAttribute('src')).toBe(STREAM_111);
    expect(container.textContent).not.toContain('Ascolti gratuiti questo mese');
  });
});

describe('fine brano: passaggio sincrono al successivo di audio.com', () => {
  it('parte nello stesso evento con il permesso inviato insieme; la riserva non lo precarica', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia audio.com');
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_111);
    await fire(first, 'playing');

    // ~20 s before the end: only GET /api/music/access (never a permit, never audio.com bytes).
    const accessCalls = fetchPaths().filter((path) => path === '/api/music/access').length;
    await nearEnd(first, a);
    expect(fetchPaths().filter((path) => path === '/api/music/access').length).toBe(
      accessCalls + 1,
    );
    expect(permits).toEqual(['audiocom:111']);
    expect(second.getAttribute('src')).toBeNull();

    play().mockClear();
    await act(async () => {
      endTrack(first, a);
      // Same task as 'ended': new src + play() with no network wait, permit request alongside.
      expect(first.getAttribute('src')).toBe(STREAM_222);
      expect(play()).toHaveBeenCalledTimes(1);
      expect(permits).toEqual(['audiocom:111', 'audiocom:222']);
      await flush();
    });
    await settle();
    expect(text(container, 'current')).toBe('audiocom:222');
    expect(first.getAttribute('src')).toBe(STREAM_222);
    expect(second.getAttribute('src')).toBeNull();
    expect(text(container, 'block')).toBe('');
    expect(text(container, 'status')).not.toBe('error');
  });

  it('il server rifiuta il successivo (limite raggiunto nel frattempo): audio fermato e invito', async () => {
    const { container, first, second, a } = await mountPlayer();
    await start(container, 'Avvia audio.com');
    await settle();
    await nearEnd(first, a);
    playsResponse = async () =>
      json({ allowed: false, reason: 'monthly_limit', used: 40, limit: 40 }, 402);

    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    await settle();
    expect(permits).toEqual(['audiocom:111', 'audiocom:222']);
    expect(first.getAttribute('src')).toBeNull();
    expect(second.getAttribute('src')).toBeNull();
    expect(text(container, 'current')).toBe('audiocom:222');
    expect(text(container, 'status')).toBe('idle');
    expect(text(container, 'block')).toBe('monthly_limit');
    expect(container.textContent).toContain('Hai usato i 40 ascolti gratuiti di questo mese.');
  });

  it('il limite previsto dai dati di accesso blocca prima dell’audio, senza permesso', async () => {
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia audio.com');
    await settle();
    access = { premium: false, signedIn: true, playsUsed: 40, playsLimit: 40 };
    await nearEnd(first, a);
    play().mockClear();

    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    await settle();
    expect(permits).toEqual(['audiocom:111']);
    expect(play()).not.toHaveBeenCalled();
    expect(first.getAttribute('src')).toBeNull();
    expect(text(container, 'block')).toBe('monthly_limit');
  });

  it('senza dati di accesso aspetta il permesso prima dell’audio (percorso normale)', async () => {
    access = null;
    const answer = deferred<Response>();
    const { container, first, a } = await mountPlayer();
    await start(container, 'Avvia audio.com');
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_111);
    await nearEnd(first, a);
    playsResponse = () => answer.promise;
    play().mockClear();

    await act(async () => {
      endTrack(first, a);
      await flush();
    });
    expect(permits).toEqual(['audiocom:111', 'audiocom:222']);
    expect(first.getAttribute('src')).not.toBe(STREAM_222);
    expect(play()).not.toHaveBeenCalled();

    await act(async () => {
      answer.resolve(json({ allowed: true, used: 5, limit: 40 }));
      await flush();
    });
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_222);
    expect(play()).toHaveBeenCalledTimes(1);
    expect(text(container, 'current')).toBe('audiocom:222');
  });
});

describe('id storici upload:audiocom~<id>', () => {
  it('un brano con l’id storico vale come audiocom:<id>: permesso e invito per un ospite', async () => {
    playsResponse = async () =>
      json({ allowed: false, reason: 'login_required', used: 0, limit: 40 }, 401);
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia id storico');
    await settle();
    expect(permits).toEqual(['audiocom:111']);
    expect(text(container, 'current')).toBe('audiocom:111');
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'block')).toBe('login_required');
  });

  it('la coda salvata nel browser torna con audiocom:<id> e Play chiede il permesso', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    window.localStorage.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({ owner: 'u1', queue: [legacyAlba], index: 0, position: 0 }),
    );
    const { container, first } = await mountPlayer();
    expect(text(container, 'current')).toBe('audiocom:111');
    expect(permits).toEqual([]);

    await act(async () => {
      button(container, 'Riproduci Alba sul mare').click();
      await flush();
    });
    await settle();
    expect(permits).toEqual(['audiocom:111']);
    expect(first.getAttribute('src')).toBe(STREAM_111);
    // La coda salvata ora porta l'id nuovo: l'id storico non torna più.
    const saved = window.localStorage.getItem(PLAYER_STORAGE_KEY) ?? '';
    expect(saved).toContain('"qualifiedId":"audiocom:111"');
    expect(saved).not.toContain('upload:audiocom~');
  });
});

describe('le altre fonti non cambiano', () => {
  it('un brano della libreria pubblica (upload:<id>) suona senza permesso né contatore', async () => {
    const { container, first } = await mountPlayer();
    await start(container, 'Avvia upload');
    await settle();
    expect(permits).toEqual([]);
    expect(fetchPaths()).not.toContain('/api/music/plays');
    expect(first.getAttribute('src')).toBe(publicUpload.streamUrl);
    expect(container.textContent).not.toContain('Ascolti gratuiti questo mese');
  });
});
