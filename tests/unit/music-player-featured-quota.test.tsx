// @polsia:user-owned — brani in evidenza della Home nel player: conteggio Free a parte (30 avvii al
// mese). Il player chiede il permesso (POST /api/music/plays con `upload:<pathname>`, solo verifica)
// PRIMA di far partire lo stream del proxy: oltre il limite compare il messaggio del conteggio dei
// brani in evidenza (senza invito a Premium) e nessun audio parte; sotto il limite l'audio parte e
// il contatore dice «Ascolti gratuiti dei brani in evidenza questo mese: X di 30». I due conteggi
// non si mescolano. Senza rete verso il permesso l'audio parte lo stesso: decide la route di stream
// (a differenza di audio.com). Gli upload pubblici (cuid) non chiedono nulla.
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
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => auth.state }));

import { homeTrackToTrack, publicUploadToTrack } from '@/components/custom/music/live-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const PATHNAME = 'Pop/Autrice - Canzone.mp3';
const FEATURED_ID = `upload:${PATHNAME}`;
const STREAM_PATH = `/api/music/home-tracks/stream?p=${encodeURIComponent(PATHNAME)}`;

const featured = homeTrackToTrack({
  id: PATHNAME,
  title: 'Canzone',
  artist: 'Autrice',
  streamUrl: STREAM_PATH,
  durationSeconds: 0,
  artworkUrl: null,
});
const upload = publicUploadToTrack({
  id: 'c'.repeat(25),
  title: 'Mio brano',
  artist: 'Io',
  streamUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/mio.mp3',
  durationSeconds: 120,
});
const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:J7Xb000',
  title: 'Luci basse',
  artistName: 'Artista Audius',
  artworkUrl: null,
  sourceLabel: 'Audius',
  sourceUrl: 'https://audius.co/x/luci-basse',
  durationSeconds: 180,
  streamUrl: null,
  playbackMode: 'audius',
};

const queues: Record<string, MusicPlayerTrack[]> = {
  'Avvia in evidenza': [featured],
  'Avvia upload': [upload],
  'Avvia Audius': [audius],
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
      <output data-testid="plays">{player.playsUsed ?? 'null'}</output>
      <output data-testid="featured-plays">{player.featuredPlaysUsed ?? 'null'}</output>
    </>
  );
}

const roots: Array<ReturnType<typeof createRoot>> = [];
let access: Record<string, unknown> | null;
let playsResponse: (qualifiedId: string) => Promise<Response>;
let permits: string[];

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

/** L'avviso del blocco (invito ad accedere o conteggio finito), se mostrato. */
function blockNotice(container: HTMLElement) {
  return (
    [...container.querySelectorAll('output')].find((item) =>
      /Hai usato i|serve un account/.test(item.textContent ?? ''),
    ) ?? null
  );
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
  const first = container.querySelector('audio') as HTMLAudioElement;
  return { container, first };
}

async function start(container: HTMLElement, label: string) {
  await act(async () => {
    button(container, label).click();
    await flush();
  });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await flush();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  auth.state = { data: { user: { id: 'u1' } }, isPending: false };
  access = {
    premium: false,
    signedIn: true,
    playsUsed: 3,
    playsLimit: 40,
    featuredPlaysUsed: 7,
    featuredPlaysLimit: 30,
  };
  playsResponse = async () => json({ allowed: true, used: 8, limit: 30 });
  permits = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
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
    }),
  );
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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
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
  document.body.replaceChildren();
});

describe('brano in evidenza: il permesso prima dell’audio, con il suo conteggio', () => {
  it('chiede /api/music/plays con upload:<pathname>; con il sì parte dal proxy e il contatore dice X di 30', async () => {
    const answer = deferred<Response>();
    playsResponse = () => answer.promise;
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia in evidenza');
    expect(permits).toEqual([FEATURED_ID]);
    // Nessun byte dal proxy prima della risposta: né sorgente né play().
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'status')).toBe('loading');

    await act(async () => {
      answer.resolve(json({ allowed: true, used: 8, limit: 30 }));
      await flush();
    });
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_PATH);
    expect(play()).toHaveBeenCalledTimes(1);
    expect(text(container, 'current')).toBe(FEATURED_ID);
    expect(text(container, 'block')).toBe('');
    expect(permits).toEqual([FEATURED_ID]);
    // Il contatore dei brani in evidenza, senza invito a Premium; quello del catalogo non cambia.
    expect(container.textContent).toContain(
      'Ascolti gratuiti dei brani in evidenza questo mese: 8 di 30.',
    );
    expect(container.textContent).not.toContain('Illimitati con Premium');
    expect(text(container, 'featured-plays')).toBe('8');
    expect(text(container, 'plays')).toBe('3');
  });

  it('oltre i 30 avvii del mese: il messaggio del conteggio dei brani in evidenza, nessun audio, nessun invito a Premium', async () => {
    playsResponse = async () =>
      json({ allowed: false, reason: 'monthly_limit', used: 30, limit: 30 }, 402);
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia in evidenza');
    await settle();
    expect(permits).toEqual([FEATURED_ID]);
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'status')).toBe('idle');
    expect(text(container, 'block')).toBe('monthly_limit');
    const notice = blockNotice(container);
    expect(notice?.textContent).toContain(
      'Hai usato i 30 ascolti gratuiti dei brani in evidenza di questo mese',
    );
    expect(notice?.textContent).toContain('Puoi continuare con brani Audius, podcast, radio');
    expect(notice?.textContent).not.toContain('Premium');
    expect(notice?.querySelector('a')).toBeNull();
    // Il conteggio del catalogo resta quello di /api/music/access.
    expect(text(container, 'featured-plays')).toBe('30');
    expect(text(container, 'plays')).toBe('3');
  });

  it('ospite: invito ad accedere e nessun audio', async () => {
    auth.state = { data: null, isPending: false };
    access = {
      premium: false,
      signedIn: false,
      playsUsed: null,
      playsLimit: 40,
      featuredPlaysUsed: null,
      featuredPlaysLimit: 30,
    };
    playsResponse = async () =>
      json({ allowed: false, reason: 'login_required', used: 0, limit: 30 }, 401);
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia in evidenza');
    await settle();
    expect(permits).toEqual([FEATURED_ID]);
    expect(first.getAttribute('src')).toBeNull();
    expect(play()).not.toHaveBeenCalled();
    expect(text(container, 'block')).toBe('login_required');
    expect(container.textContent).toContain('Per ascoltare serve un account gratuito.');
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
  });

  it('i due conteggi restano separati: il permesso di un brano aggiorna solo il suo', async () => {
    playsResponse = async (qualifiedId) =>
      qualifiedId === FEATURED_ID
        ? json({ allowed: true, used: 8, limit: 30 })
        : json({ allowed: true, used: 12, limit: 40 });
    const { container, first } = await mountPlayer();

    await start(container, 'Avvia in evidenza');
    await settle();
    expect(text(container, 'featured-plays')).toBe('8');
    expect(text(container, 'plays')).toBe('3');

    await start(container, 'Avvia Audius');
    await settle();
    expect(permits).toEqual([FEATURED_ID, 'audius:J7Xb000']);
    expect(first.getAttribute('src')).toBe(trackStreamPath(audius));
    expect(text(container, 'plays')).toBe('12');
    expect(text(container, 'featured-plays')).toBe('8');
    expect(container.textContent).toContain('Ascolti gratuiti questo mese: 12 di 40.');
    expect(container.textContent).toContain('Illimitati con Premium');
  });

  it('senza rete verso il permesso l’audio parte lo stesso: decide la route di stream', async () => {
    playsResponse = () => Promise.reject(new TypeError('Failed to fetch'));
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia in evidenza');
    await settle();
    expect(permits).toEqual([FEATURED_ID]);
    expect(first.getAttribute('src')).toBe(STREAM_PATH);
    expect(play()).toHaveBeenCalledTimes(1);
    expect(text(container, 'error')).toBe('');
    expect(text(container, 'block')).toBe('');
  });

  it('Premium: suona senza contatore', async () => {
    access = {
      premium: true,
      signedIn: true,
      playsUsed: 0,
      playsLimit: null,
      featuredPlaysUsed: 0,
      featuredPlaysLimit: null,
    };
    playsResponse = async () => json({ allowed: true, used: 0, limit: null });
    const { container, first } = await mountPlayer();

    await start(container, 'Avvia in evidenza');
    await settle();
    expect(first.getAttribute('src')).toBe(STREAM_PATH);
    expect(container.textContent).not.toContain('Ascolti gratuiti');
  });

  it('un upload pubblico (cuid) non chiede nessun permesso e parte subito', async () => {
    const { container, first } = await mountPlayer();
    play().mockClear();

    await start(container, 'Avvia upload');
    await settle();
    expect(permits).toEqual([]);
    expect(first.getAttribute('src')).toBe(upload.streamUrl);
    expect(play()).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Ascolti gratuiti');
  });
});
