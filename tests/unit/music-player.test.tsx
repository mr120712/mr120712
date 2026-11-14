// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(async (_path: string) => ({ allowed: true })) }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));

import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  useMusicPlayer,
} from '@/components/custom/music/music-player';

const firstTrack: MusicPlayerTrack = {
  qualifiedId: 'audius:track-1',
  albumId: 'album-1',
  title: 'Primo brano',
  artistName: 'Artista Uno',
  artistUrl: 'https://audius.co/artist/one',
  artworkUrl: 'https://audius.co/images/cover.jpg',
  sourceLabel: 'Solco · Audius',
  sourceUrl: 'https://audius.co/artist/one',
  durationSeconds: 80,
  playbackMode: 'solco',
};
const secondTrack: MusicPlayerTrack = {
  qualifiedId: 'audius:track-2',
  albumId: 'album-1',
  title: 'Secondo brano',
  artistName: 'Artista Due',
  artistUrl: 'https://audius.co/artist/two',
  sourceLabel: 'Solco · Audius',
  sourceUrl: 'https://audius.co/artist/two',
  durationSeconds: 100,
  playbackMode: 'solco',
};
const publicTrack: MusicPlayerTrack = {
  qualifiedId: 'audius:public-track',
  title: 'Brano pubblico',
  artistName: 'Artista pubblico',
  artistUrl: 'https://audius.co/artista-pubblico',
  artworkUrl: 'https://audius.co/images/public-cover.jpg',
  sourceLabel: 'Solco · Audius',
  sourceUrl: 'https://audius.co/artista-pubblico/brano-pubblico',
  playbackMode: 'audius',
};
const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

function Probe() {
  const player = useMusicPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void player.playTrack(firstTrack, '/api/music/albums/album-1/tracks/track-1/stream', [
            firstTrack,
            secondTrack,
          ])
        }
      >
        Avvia coda
      </button>
      <button
        type="button"
        onClick={() =>
          void player.playTrack(
            { ...firstTrack, albumId: null, playbackMode: undefined },
            '/api/music/audius/tracks/track-1/stream',
          )
        }
      >
        Prova brano senza album
      </button>
      <button
        type="button"
        onClick={() =>
          void player.playTrack(publicTrack, '/api/music/audius/tracks/public-track/stream', [
            publicTrack,
          ])
        }
      >
        Avvia brano pubblico
      </button>
    </>
  );
}

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe />
      </MusicPlayerProvider>,
    ),
  );
  return container;
}

beforeEach(() => {
  mocks.apiFetch.mockReset().mockResolvedValue({ allowed: true });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('player Solco Pro', () => {
  it('riproduce un brano Audius confermato senza album o abbonamento Pro', async () => {
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia brano pubblico',
    );
    if (!start) throw new Error('Pulsante del brano pubblico non trovato.');

    await act(async () => {
      start.click();
      await Promise.resolve();
    });

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe(
      '/api/music/audius/tracks/public-track/playback',
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/public-track/stream',
    );
    expect(container.textContent).toContain('Brano pubblico');
    expect(container.textContent).toContain('Artista pubblico');
    expect(container.textContent).not.toContain('Solco Pro');
  });

  it('verifica ogni traccia, espone la coda, i controlli avanti/indietro e il seek', async () => {
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia coda',
    );
    if (!start) throw new Error('Pulsante di prova non trovato.');
    await act(async () => {
      start.click();
      await Promise.resolve();
    });
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe(
      '/api/music/albums/album-1/tracks/track-1/playback',
    );
    expect(container.textContent).toContain('Primo brano');
    expect(container.textContent).toContain('Solco · Audius');
    expect(container.textContent).toContain('Coda · 2 brani');
    const queue = container.querySelector('details ol');
    expect(queue?.textContent).toContain('Artista Uno');
    expect(queue?.querySelector('a')?.getAttribute('href')).toBe(firstTrack.artistUrl);
    expect(queue?.querySelector('[class*="queueArtwork"] img')?.getAttribute('src')).toBe(
      firstTrack.artworkUrl,
    );
    expect(queue?.querySelectorAll('[class*="queueArtwork"] svg').length).toBeGreaterThan(0);

    const pause = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Metti in pausa Primo brano"]',
    );
    if (!pause) throw new Error('Controllo pausa non trovato.');
    await act(async () => {
      pause.click();
    });
    expect(container.querySelector('audio')?.getAttribute('src')).toContain(
      '/api/music/albums/album-1/tracks/track-1/stream',
    );
    const resume = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Primo brano"]',
    );
    if (!resume) throw new Error('Controllo riproduzione non trovato.');
    await act(async () => {
      resume.click();
      await Promise.resolve();
    });
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe(
      '/api/music/albums/album-1/tracks/track-1/playback',
    );
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);

    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Brano successivo"]',
    );
    if (!next) throw new Error('Controllo successivo non trovato.');
    await act(async () => {
      next.click();
      await Promise.resolve();
    });
    expect(mocks.apiFetch.mock.calls[2]?.[0]).toBe(
      '/api/music/albums/album-1/tracks/track-2/playback',
    );
    expect(container.textContent).toContain('Secondo brano');

    const previous = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Brano precedente"]',
    );
    if (!previous) throw new Error('Controllo precedente non trovato.');
    await act(async () => {
      previous.click();
      await Promise.resolve();
    });
    expect(mocks.apiFetch.mock.calls[3]?.[0]).toBe(
      '/api/music/albums/album-1/tracks/track-1/playback',
    );

    let currentTime = 0;
    const audio = container.querySelector('audio');
    if (!audio) throw new Error('Player audio non trovato.');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 80 });
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    });
    const seek = container.querySelector<HTMLInputElement>('input[type="range"]');
    if (!seek) throw new Error('Controllo di avanzamento non trovato.');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(seek, '31');
      seek.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(audio.currentTime).toBe(31);
  });

  it('non accetta un percorso di playback diverso dallo stream Audius', async () => {
    const container = await mount();
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === 'Prova brano senza album',
    );
    if (!button) throw new Error('Controllo di prova senza album non trovato.');
    await act(async () => {
      button.click();
    });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });

  it('arresta l’audio e mostra il motivo esatto quando Audius nega lo stream', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      new Error('preflight rejected', {
        cause: { allowed: false, reason: 'not_streamable' },
      }),
    );
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia coda',
    );
    if (!start) throw new Error('Pulsante di prova non trovato.');
    await act(async () => {
      start.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Audius non autorizza lo streaming di questo brano.');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });

  it('non avvia audio se Audius non è configurata', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      new Error('source inactive', {
        cause: { reason: 'source_inactive' },
      }),
    );
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia brano pubblico',
    );
    if (!start) throw new Error('Pulsante del brano pubblico non trovato.');

    await act(async () => {
      start.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'Audius non è configurata o non è disponibile. Nessun audio è stato riprodotto.',
    );
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });

  it('mostra il tempo di attesa restituito da Audius senza avviare audio', async () => {
    mocks.apiFetch.mockRejectedValueOnce(
      new Error('rate limited', {
        cause: { reason: 'rate_limited', retryAfterSeconds: 19 },
      }),
    );
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia coda',
    );
    if (!start) throw new Error('Pulsante di prova non trovato.');
    await act(async () => {
      start.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      'Audius ha limitato le richieste. Riprova tra 19 secondi.',
    );
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });

  it.each([
    [
      'account non Pro',
      'pro_required',
      'L’ascolto integrale richiede un abbonamento Solco Pro attivo.',
    ],
    [
      'diritti non verificati',
      'rights_unverified',
      'Questo brano non è disponibile: fonte o diritti di streaming non sono verificati.',
    ],
  ])('blocca il player per %s senza avviare byte audio', async (_label, reason, message) => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('access denied', { cause: { reason } }));
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia coda',
    );
    if (!start) throw new Error('Pulsante di prova non trovato.');
    await act(async () => {
      start.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(message);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });

  it('rivalida l’accesso quando si riprende un brano in pausa', async () => {
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia coda',
    );
    if (!start) throw new Error('Pulsante di prova non trovato.');
    await act(async () => {
      start.click();
      await Promise.resolve();
    });
    const pause = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Metti in pausa Primo brano"]',
    );
    if (!pause) throw new Error('Controllo pausa non trovato.');
    await act(async () => {
      pause.click();
    });
    mocks.apiFetch.mockRejectedValueOnce(
      new Error('access denied', { cause: { reason: 'pro_required' } }),
    );
    const resume = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Primo brano"]',
    );
    if (!resume) throw new Error('Controllo ripresa non trovato.');
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    await act(async () => {
      resume.click();
      // play() runs inside the tap, before the access check answers (iOS drops a later play()).
      expect(play).toHaveBeenCalledTimes(2);
      await Promise.resolve();
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(
      'L’ascolto integrale richiede un abbonamento Solco Pro attivo.',
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });

  it('il mini player ha il pulsante Autoplay continuo, che si accende e si salva', async () => {
    window.localStorage.removeItem('solco:autoplay');
    const container = await mount();
    const start = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Avvia brano pubblico',
    );
    if (!start) throw new Error('Pulsante del brano pubblico non trovato.');
    await act(async () => {
      start.click();
      await Promise.resolve();
    });

    const mini = container.querySelector('aside[aria-label="Player musicale Solco"]');
    if (!mini) throw new Error('Mini player non trovato.');
    const autoplay = mini.querySelector<HTMLButtonElement>(
      'button[aria-label^="Autoplay continuo"]',
    );
    if (!autoplay) throw new Error('Pulsante Autoplay nel mini player non trovato.');
    expect(autoplay.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      autoplay.click();
      await Promise.resolve();
    });
    expect(window.localStorage.getItem('solco:autoplay')).toBe('1');
    expect(autoplay.getAttribute('aria-pressed')).toBe('true');
    window.localStorage.removeItem('solco:autoplay');
  });
});
