// @polsia:user-owned — player condiviso: avviso "video fermato" solo dopo una pausa dovuta alla
// pagina nascosta (una volta per video), "Ascolta in background" nel mini player, contatore
// degli ascolti gratuiti per fonte e link Audius per i brani con licenza diversa.
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
import { YouTubeQueuePlayer } from '@/components/custom/music/youtube-queue-player';

const NOTICE = 'Il video si è fermato perché sei uscito dall’app.';

const video: MusicPlayerTrack = {
  qualifiedId: 'youtube:aaaaaaaaaaa',
  title: 'Primo video',
  artistName: 'Canale A',
  sourceLabel: 'YouTube',
  sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  playbackMode: 'youtube',
};
const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:track-a',
  title: 'Alba',
  artistName: 'Artista Uno',
  sourceLabel: 'Audius',
  sourceUrl: 'https://audius.co/artistauno/alba',
  durationSeconds: 200,
  playbackMode: 'audius',
};
const episode: MusicPlayerTrack = {
  qualifiedId: 'podcast:123~ep1',
  title: 'Episodio 1',
  artistName: 'Show',
  sourceLabel: 'Podcast',
  sourceUrl: null,
  durationSeconds: 600,
  playbackMode: 'podcast',
};
const station: MusicPlayerTrack = {
  qualifiedId: 'radio:station-1',
  title: 'Radio Prova',
  artistName: 'Italia',
  sourceLabel: 'Radio dal vivo',
  sourceUrl: null,
  playbackMode: 'radio',
};
const starts: Record<string, MusicPlayerTrack> = {
  'Avvia video': video,
  'Avvia Audius': audius,
  'Avvia podcast': episode,
  'Avvia radio': station,
};

type Events = { onStateChange: (event: { data: number }) => void };
let events: Events | null = null;
const yt = {
  loadVideoById: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  seekTo: vi.fn(),
  getCurrentTime: vi.fn(() => 0),
  getDuration: vi.fn(() => 200),
  destroy: vi.fn(),
};
const roots: Array<ReturnType<typeof createRoot>> = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function Probe() {
  const player = useMusicPlayer();
  return (
    <>
      {Object.entries(starts).map(([label, track]) => (
        <button
          key={label}
          type="button"
          onClick={() => void player.playTrack(track, trackStreamPath(track) ?? '')}
        >
          {label}
        </button>
      ))}
    </>
  );
}

async function mount(children = <Probe />) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<MusicPlayerProvider>{children}</MusicPlayerProvider>));
  await act(flush);
  return container;
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Pulsante ${label} non trovato.`);
  return found;
}

async function start(container: HTMLElement, label: string) {
  await act(async () => {
    button(container, label).click();
    await flush();
  });
  await act(flush);
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

async function ytState(data: number) {
  await act(async () => events?.onStateChange({ data }));
}

function notice(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-background-switch-notice]');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const fn of Object.values(yt)) fn.mockClear();
  events = null;
  vi.stubGlobal('YT', {
    Player: function Player(_el: HTMLElement, options: { events: Events }) {
      events = options.events;
      return yt;
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      const body = path.startsWith('/api/music/access')
        ? { premium: false, signedIn: true, playsUsed: 3, playsLimit: 40 }
        : path.startsWith('/api/music/plays')
          ? { allowed: true, used: 3, limit: 40 }
          : path.includes('source-status')
            ? { sources: [{ id: 'audius', active: true }] }
            : path.includes('/api/music/jamendo')
              ? { outcome: 'not_configured', tracks: [] }
              : {};
      return new Response(JSON.stringify(body));
    }),
  );
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('avviso "video fermato" nel player condiviso', () => {
  it('compare al ritorno solo se il video suonava ed è stato fermato dalla pagina nascosta', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    expect(events).not.toBeNull();
    await ytState(1);

    await setHidden(true);
    expect(yt.pauseVideo).toHaveBeenCalled();
    await ytState(2);
    // Never while hidden, and never a switch without a tap.
    expect(notice(container)).toBeNull();
    expect(yt.playVideo).not.toHaveBeenCalled();

    await setHidden(false);
    const shown = notice(container);
    expect(shown?.textContent).toContain(NOTICE);
    // Below the official player, inside the video dock (never over it).
    expect(shown?.closest('[data-youtube-official-frame]')).not.toBeNull();
    expect(shown?.previousElementSibling?.className).toMatch(/videoHost/);
    expect(container.contains(document.activeElement)).toBe(false);
    expect(button(container, 'Continua in background con Audius')).toBeTruthy();
    // Nothing was switched automatically: no Audius search, no audio.
    expect(mocks.apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/music/search'),
      expect.anything(),
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();

    // "Riprendi il video" resumes the official player and closes the notice.
    await act(async () => button(container, 'Riprendi il video').click());
    expect(yt.playVideo).toHaveBeenCalledTimes(1);
    expect(notice(container)).toBeNull();
  });

  it('una sola volta per video', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    await setHidden(true);
    await ytState(2);
    await setHidden(false);
    expect(notice(container)).not.toBeNull();
    await act(async () => button(container, 'Chiudi l’avviso sul video in pausa').click());
    expect(notice(container)).toBeNull();

    await ytState(1);
    await setHidden(true);
    await ytState(2);
    await setHidden(false);
    expect(notice(container)).toBeNull();
  });

  it('niente avviso se il video era già in pausa o se suona un brano Audius', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    await ytState(2);
    await setHidden(true);
    await setHidden(false);
    expect(notice(container)).toBeNull();

    await start(container, 'Avvia Audius');
    const audio = container.querySelector('audio');
    if (!audio) throw new Error('audio mancante');
    await act(async () => audio.dispatchEvent(new Event('playing')));
    await setHidden(true);
    await setHidden(false);
    expect(notice(container)).toBeNull();
  });

  it('il video che parte mentre Solco è nascosto viene fermato e spiegato al ritorno', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await setHidden(true);
    yt.pauseVideo.mockClear();
    await ytState(1);
    expect(yt.pauseVideo).toHaveBeenCalled();
    await setHidden(false);
    expect(notice(container)?.textContent).toContain(NOTICE);
  });

  it('un video che si ribufferizza quando Solco viene nascosto conta come in riproduzione', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    // Re-buffering mid-song (or after a seek): the React status is 'loading', the engine plays.
    await ytState(3);
    await setHidden(true);
    expect(yt.pauseVideo).toHaveBeenCalled();
    await ytState(2);
    await setHidden(false);
    expect(notice(container)?.textContent).toContain(NOTICE);
  });

  it('niente avviso dopo la fine del video', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    await ytState(0);
    await setHidden(true);
    await setHidden(false);
    expect(notice(container)).toBeNull();
  });

  it('niente avviso se l’utente mette in pausa e blocca subito il telefono', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    // Paused from Solco: YouTube has not reported PAUSED yet when the phone is locked.
    await act(async () => button(container, 'Metti in pausa Primo video').click());
    expect(yt.pauseVideo).toHaveBeenCalledTimes(1);
    await setHidden(true);
    await setHidden(false);
    expect(notice(container)).toBeNull();
  });

  it('il testo è annunciato da una regione live già presente prima dell’avviso', async () => {
    const container = await mount();
    const region = document.querySelector('[data-background-switch-announcer]');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent).toBe('');
    await start(container, 'Avvia video');
    await ytState(1);
    await setHidden(true);
    await ytState(2);
    await setHidden(false);
    expect(notice(container)).not.toBeNull();
    // Same node, text set after it existed: announced when the notice appears.
    expect(document.querySelector('[data-background-switch-announcer]')).toBe(region);
    expect(region?.textContent).toContain(NOTICE);
    await act(async () => button(container, 'Chiudi l’avviso sul video in pausa').click());
    expect(region?.textContent).toBe('');
  });

  it('chiuso con il focus dentro, il focus passa al play/pausa del mini player', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    await setHidden(true);
    await ytState(2);
    await setHidden(false);
    const close = button(container, 'Chiudi l’avviso sul video in pausa');
    close.focus();
    await act(async () => close.click());
    expect(notice(container)).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Riproduci Primo video');
    expect(document.activeElement?.closest('aside[aria-label="Player musicale Solco"]')).not.toBe(
      null,
    );
  });

  it('nel player a schermo intero l’avviso sta sotto il video, nel testo del brano', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    await ytState(1);
    await act(async () => button(container, 'Apri il player: Primo video').click());
    await setHidden(true);
    await ytState(2);
    await setHidden(false);
    const shown = notice(container);
    expect(shown).not.toBeNull();
    expect(shown?.closest('[data-youtube-official-frame]')).toBeNull();
    expect(shown?.closest('section[aria-label="Player a schermo intero"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-background-switch-notice]')).toHaveLength(1);
  });
});

describe('"Ascolta in background" sempre visibile con un video YouTube', () => {
  it('compare nel mini player e nel player completo con il suggerimento', async () => {
    const container = await mount();
    await start(container, 'Avvia video');
    const mini = container.querySelector('aside[aria-label="Player musicale Solco"]');
    const miniButton = mini?.querySelector<HTMLButtonElement>(
      'button[aria-label="Ascolta Primo video in background"]',
    );
    expect(miniButton).not.toBeNull();
    expect(miniButton?.getAttribute('title')).toBe(
      'Ascolta in background: continua con lo schermo bloccato',
    );
    // Secondary to play/pause: the play button keeps its own, larger control.
    expect(mini?.querySelector('button[aria-label="Riproduci Primo video"]')).not.toBeNull();
    const full = container.querySelector('section[aria-label="Player a schermo intero"]');
    expect(full?.textContent).toContain('Ascolta in background');
    expect(full?.textContent).toContain('continua con lo schermo bloccato');
  });

  it('non compare per i brani audio', async () => {
    const container = await mount();
    await start(container, 'Avvia Audius');
    expect(container.textContent).not.toContain('continua con lo schermo bloccato');
    expect(container.querySelector('button[aria-label$="in background"]')).toBeNull();
  });
});

describe('contatore degli ascolti gratuiti per fonte', () => {
  const counter = 'Ascolti gratuiti questo mese: 3 di 40.';

  it('visibile per Audius e podcast', async () => {
    const container = await mount();
    await start(container, 'Avvia Audius');
    expect(container.textContent).toContain(counter);
    await start(container, 'Avvia podcast');
    expect(container.textContent).toContain(counter);
  });

  it('nascosto per radio e YouTube (non contano)', async () => {
    const container = await mount();
    await start(container, 'Avvia radio');
    expect(container.textContent).not.toContain('Ascolti gratuiti');
    await start(container, 'Avvia video');
    expect(container.textContent).not.toContain('Ascolti gratuiti');
  });
});

describe('licenza non consentita', () => {
  it('spiega che il brano si ascolta solo su Audius e linka il brano', async () => {
    mocks.apiFetch.mockRejectedValue(
      new Error('license_not_allowed', {
        cause: { allowed: false, reason: 'license_not_allowed' },
      }),
    );
    const container = await mount();
    await start(container, 'Avvia Audius');
    expect(container.textContent).toContain(
      "L'artista ha scelto una licenza diversa: questo brano si ascolta solo su Audius.",
    );
    const link = [...container.querySelectorAll<HTMLAnchorElement>('output a')].find(
      (item) => item.textContent === 'Ascolta su Audius',
    );
    expect(link?.getAttribute('href')).toBe('https://audius.co/artistauno/alba');
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });
});

describe('coda YouTube della ricerca', () => {
  const items = [
    { videoId: 'ccccccccccc', title: 'Video coda', channelTitle: 'Canale C' },
    { videoId: 'ddddddddddd', title: 'Secondo video', channelTitle: 'Canale D' },
  ];

  function Queue() {
    const [index, setIndex] = useState<number | null>(0);
    if (index === null) return null;
    return (
      <YouTubeQueuePlayer
        items={items}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
      />
    );
  }

  it('offre "Ascolta in background" e l’avviso al ritorno dopo la pausa in background', async () => {
    let queueEvents: { onReady: () => void; onStateChange: (e: { data: number }) => void } | null =
      null;
    const queuePlayer = { ...yt, playVideo: vi.fn(), pauseVideo: vi.fn() };
    vi.stubGlobal('YT', {
      Player: function Player(_el: HTMLElement, options: { events: typeof queueEvents }) {
        queueEvents = options.events;
        return queuePlayer;
      },
    });
    const container = await mount(<Queue />);
    await act(async () => queueEvents?.onReady());
    const section = container.querySelector('section[aria-label="Coda di riproduzione YouTube"]');
    expect(section?.textContent).toContain('continua con lo schermo bloccato');

    await act(async () => queueEvents?.onStateChange({ data: 1 }));
    await setHidden(true);
    expect(queuePlayer.pauseVideo).toHaveBeenCalledTimes(1);
    await act(async () => queueEvents?.onStateChange({ data: 2 }));
    await setHidden(false);
    const shown = section?.querySelector('[data-background-switch-notice]');
    expect(shown?.textContent).toContain(NOTICE);
    expect(shown?.previousElementSibling?.hasAttribute('data-youtube-official-frame')).toBe(true);

    const resume = button(container, 'Riprendi il video');
    resume.focus();
    await act(async () => resume.click());
    expect(queuePlayer.playVideo).toHaveBeenCalledTimes(1);
    expect(section?.querySelector('[data-background-switch-notice]')).toBeNull();
    // The focus stays in the queue player instead of falling back to the page.
    expect(document.activeElement).toBe(section);
  });

  it('il video successivo che non è ancora partito non riceve l’avviso', async () => {
    let queueEvents: { onReady: () => void; onStateChange: (e: { data: number }) => void } | null =
      null;
    const queuePlayer = { ...yt, loadVideoById: vi.fn(), pauseVideo: vi.fn() };
    vi.stubGlobal('YT', {
      Player: function Player(_el: HTMLElement, options: { events: typeof queueEvents }) {
        queueEvents = options.events;
        return queuePlayer;
      },
    });
    const container = await mount(<Queue />);
    await act(async () => queueEvents?.onReady());
    await act(async () => queueEvents?.onStateChange({ data: 1 }));
    // Next item: loaded, but it never reports PLAYING before Solco is hidden.
    await act(async () => button(container, 'Successivo').click());
    expect(queuePlayer.loadVideoById).toHaveBeenCalledWith('ddddddddddd');
    await setHidden(true);
    await setHidden(false);
    expect(notice(container)).toBeNull();
  });
});
