// @polsia:user-owned — avviso "video fermato": il tocco su "Continua in background con Audius"
// usa il flusso di "Ascolta in background" e sblocca l'audio nello stesso tocco (iOS). Una ricerca
// fallita non diventa "non è su Audius"; il focus non cade sulla pagina quando l'avviso si chiude;
// una sola ricerca per video anche con due controlli.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playTrack: vi.fn(),
  primeAudio: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  order: [] as string[],
}));
vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { success: mocks.success }) }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({ playTrack: mocks.playTrack, primeAudio: mocks.primeAudio }),
  trackStreamPath: () => null,
}));

const video = { videoId: 'abcdefghijk', title: 'Artista Uno - Notte Chiara', channelTitle: 'X' };
const audiusTrack = {
  provider: 'audius',
  id: 'a1',
  qualifiedId: 'audius:a1',
  title: 'Notte Chiara',
  artistName: 'Artista Uno',
  artistHandle: 'artistauno',
  artistId: 'u1',
  artistQualifiedId: 'audius:u1',
  artistUrl: 'https://audius.co/artistauno',
  trackUrl: 'https://audius.co/artistauno/notte-chiara',
  artworkUrl: 'https://example.test/a.jpg',
  durationSeconds: 200,
  genre: null,
  mood: null,
  tags: null,
  releaseDate: null,
  license: null,
  licensorName: null,
  copyrightNotice: null,
  producerCopyrightNotice: null,
  attributionRemovalRequested: false,
  attributionComplete: true,
  playbackEligible: true,
  playbackReason: 'ready',
};

function searchBody(tracks: unknown[]) {
  return {
    source: 'audius',
    outcome: tracks.length ? 'results' : 'no_results',
    tracks,
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
    sourceStatus: {
      id: 'audius',
      label: 'Audius',
      active: true,
      searchOutcome: 'results',
      summary: 'ok',
      prerequisite: 'ok',
    },
  };
}

const roots: ReturnType<typeof createRoot>[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** How the Audius search answers: 'offline' rejects, a number is an HTTP error status. */
type SearchMode = 'ok' | 'offline' | number;

async function mount(
  audiusTracks: unknown[],
  options: { search?: () => SearchMode; withButton?: boolean; gate?: Promise<void> } = {},
) {
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes('source-status')) {
        return new Response(JSON.stringify({ sources: [{ id: 'audius', active: true }] }));
      }
      if (path.includes('/api/music/jamendo')) {
        return new Response(JSON.stringify({ outcome: 'not_configured', tracks: [] }));
      }
      mocks.order.push('search');
      await options.gate;
      const mode = options.search?.() ?? 'ok';
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      if (typeof mode === 'number') {
        return new Response(JSON.stringify({ error: 'rate_limited' }), { status: mode });
      }
      return new Response(JSON.stringify(searchBody(audiusTracks)));
    }),
  );
  const notice = await import('@/components/custom/music/background-switch-notice');
  const { BackgroundListenButton } = await import(
    '@/components/custom/music/background-listen-button'
  );
  const { BackgroundSwitchNotice } = notice;
  const onResume = vi.fn();
  const onDismiss = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  // A stable control of the player, outside the notice.
  const target = document.createElement('button');
  target.textContent = 'Play/pausa del player';
  document.body.append(target);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <>
        {options.withButton ? <BackgroundListenButton video={video} /> : null}
        <BackgroundSwitchNotice
          video={video}
          onResume={onResume}
          onDismiss={onDismiss}
          focusTarget={() => target}
        />
      </>,
    ),
  );
  await act(flush);
  return { container, onResume, onDismiss, target, text: notice.RETURN_NOTICE_TEXT, notice };
}

function noticeText(container: HTMLElement) {
  return container.querySelector('[data-notice-text]')?.textContent;
}

function announcer() {
  return document.querySelector<HTMLElement>('[data-background-switch-announcer]');
}

function button(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`Pulsante ${name} non trovato.`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.order.length = 0;
  mocks.playTrack.mockReset().mockResolvedValue(undefined);
  mocks.primeAudio.mockReset().mockImplementation(() => mocks.order.push('prime'));
  mocks.toast.mockReset();
  mocks.success.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('avviso al ritorno su Solco', () => {
  it('spiega la pausa senza rubare il focus, con un testo annunciato (role status)', async () => {
    const { container, text } = await mount([audiusTrack]);
    expect(noticeText(container)).toBe(
      'Il video si è fermato perché sei uscito dall’app. YouTube non permette l’ascolto in background.',
    );
    expect(noticeText(container)).toBe(text);
    // Announced by a live region that already exists when its text arrives (never inserted
    // together with it), outside the notice so it survives the notice's own mounting.
    const region = announcer();
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(container.contains(region)).toBe(false);
    await wait(150);
    expect(region?.textContent).toBe(text);
    expect(container.contains(document.activeElement)).toBe(false);
    expect(container.querySelector('[role="dialog"], dialog')).toBeNull();
    expect(button(container, 'Continua in background con Audius')).toBeTruthy();
    expect(button(container, 'Riprendi il video')).toBeTruthy();
    expect(button(container, 'Chiudi l’avviso sul video in pausa')).toBeTruthy();
  });

  it('il tocco principale sblocca l’audio nello stesso tocco e avvia lo stesso brano su Audius', async () => {
    const { container, onDismiss } = await mount([audiusTrack]);
    const primary = button(container, 'Continua in background con Audius');
    await act(async () => {
      primary.click();
      // Same call stack as the tap: the audio element is unlocked before any network wait.
      expect(mocks.primeAudio).toHaveBeenCalledTimes(1);
      expect(mocks.order[0]).toBe('prime');
      expect(mocks.playTrack).not.toHaveBeenCalled();
      await flush();
    });
    await act(flush);
    expect(mocks.order[0]).toBe('prime');
    expect(mocks.order).toContain('search');
    expect(mocks.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ qualifiedId: 'audius:a1', playbackMode: 'audius' }),
      '/api/music/audius/tracks/a1/stream',
      expect.any(Array),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('se il brano non è su Audius lo dice e offre di riprendere o aprire su YouTube', async () => {
    const { container, onDismiss } = await mount([]);
    await act(async () => {
      button(container, 'Continua in background con Audius').click();
      await flush();
    });
    await act(flush);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(noticeText(container)).toBe(
      'Questo brano non è su Audius: puoi riprendere il video o aprirlo su YouTube.',
    );
    expect(announcer()?.textContent).toBe(noticeText(container));
    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.textContent).toContain('Apri su YouTube');
    expect(link?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
    expect(
      [...container.querySelectorAll('button')].some((item) =>
        item.textContent?.includes('Continua in background'),
      ),
    ).toBe(false);
    expect(button(container, 'Riprendi il video')).toBeTruthy();
  });

  it('si chiude con la X e "Riprendi il video" riprende il video', async () => {
    const { container, onDismiss, onResume } = await mount([audiusTrack]);
    await act(async () => button(container, 'Chiudi l’avviso sul video in pausa').click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(mocks.primeAudio).not.toHaveBeenCalled();

    await act(async () => button(container, 'Riprendi il video').click());
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('una ricerca fallita (rete, 429, 5xx) non dice "non è su Audius" e lascia riprovare', async () => {
    for (const failure of ['offline', 429, 503] as const) {
      let mode: SearchMode = failure;
      const { container, onDismiss } = await mount([audiusTrack], { search: () => mode });
      await act(async () => {
        button(container, 'Continua in background con Audius').click();
        await flush();
      });
      await act(flush);
      expect(mocks.playTrack).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(noticeText(container)).toBe(
        'Non riesco a cercare su Audius adesso. Riprova tra poco.',
      );
      expect(noticeText(container)).not.toContain('non è su Audius');
      expect(container.querySelector('a')).toBeNull();

      // The button stays: the next tap searches again and switches.
      mode = 'ok';
      await act(async () => {
        button(container, 'Continua in background con Audius').click();
        await flush();
      });
      await act(flush);
      expect(mocks.playTrack).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
      mocks.playTrack.mockClear();
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      document.body.replaceChildren();
    }
  });

  it('chiudendo l’avviso con il focus dentro, il focus va al controllo del player', async () => {
    const { container, onDismiss, onResume, target } = await mount([audiusTrack]);
    const close = button(container, 'Chiudi l’avviso sul video in pausa');
    close.focus();
    await act(async () => close.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(target);

    const resume = button(container, 'Riprendi il video');
    resume.focus();
    await act(async () => resume.click());
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(target);

    // After a successful switch to Audius too.
    const primary = button(container, 'Continua in background con Audius');
    primary.focus();
    await act(async () => {
      primary.click();
      await flush();
    });
    await act(flush);
    expect(onDismiss).toHaveBeenCalledTimes(3);
    expect(document.activeElement).toBe(target);
  });

  it('senza focus nell’avviso, chiuderlo non sposta il focus', async () => {
    const { container, target } = await mount([audiusTrack]);
    await act(async () => button(container, 'Chiudi l’avviso sul video in pausa').click());
    expect(document.activeElement).not.toBe(target);
  });

  it('pulsante e avviso dello stesso video condividono una sola ricerca e un solo avvio', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { container, onDismiss } = await mount([audiusTrack], { withButton: true, gate });
    const listen = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Ascolta Artista Uno - Notte Chiara in background"]',
    );
    if (!listen) throw new Error('pulsante Ascolta in background mancante');
    await act(async () => {
      listen.click();
      await flush();
    });
    // The search is pending: the notice shows it too and its tap joins the same search.
    const primary = button(container, 'Cerco su Audius…');
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      primary.click();
      await flush();
    });
    await act(async () => {
      release();
      await flush();
    });
    await act(flush);
    expect(mocks.order.filter((step) => step === 'search')).toHaveLength(1);
    expect(mocks.primeAudio).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
