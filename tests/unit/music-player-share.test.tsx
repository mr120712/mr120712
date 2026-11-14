// @polsia:user-owned — "Condividi" nel player: per un brano Audius il link porta il suo id (au) e
// l'immagine allegata al menu del telefono è la scheda ?au=<id>; per un video YouTube nessun id e
// la scheda ?t=…&a=… dello stesso brano. "Sfida un amico": il quiz /quiz del brano (solo con
// titolo e artista), con la domanda nel testo e mai la risposta.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(async () => ({ allowed: true })) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/search' }));

import { videoToTrack } from '@/components/custom/music/live-tracks';
import {
  MusicPlayerProvider,
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { searchParamsRecord } from '@/lib/business/social-share';
import { songQuizFromParams } from '@/lib/business/song-quiz';

const audius: MusicPlayerTrack = {
  qualifiedId: 'audius:J7Xb000',
  title: 'Luci basse',
  artistName: 'Artista Audius',
  artworkUrl: null,
  sourceLabel: 'Audius',
  sourceUrl: null,
  durationSeconds: 201,
  playbackMode: 'audius',
};

const video = videoToTrack({
  videoId: 'dQw4w9WgXcQ',
  title: 'Artista Finto - Canzone Finta (Official Video)',
  channelTitle: 'Canale Finto',
  thumbnailUrl: null,
});

const roots: Array<ReturnType<typeof createRoot>> = [];
let fetchMock: ReturnType<typeof vi.fn>;

function Probe({ track }: { track: MusicPlayerTrack }) {
  const player = useMusicPlayer();
  return (
    <button
      type="button"
      data-start
      onClick={() => void player.playTrack(track, trackStreamPath(track) ?? '', [track])}
    >
      Avvia
    </button>
  );
}

/** Avvia il brano e apre il player a schermo intero. */
async function openFullPlayer(track: MusicPlayerTrack) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <Probe track={track} />
      </MusicPlayerProvider>,
    ),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[data-start]')?.click();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  const expand = document.querySelector<HTMLButtonElement>('button[aria-label^="Apri il player"]');
  expect(expand).not.toBeNull();
  await act(async () => expand?.click());
}

/** Apre il menu del pulsante con questo nome accessibile. */
async function openMenu(ariaLabel: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`);
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function openShareMenu(track: MusicPlayerTrack) {
  await openFullPlayer(track);
  await openMenu(`Condividi ${track === audius ? 'Luci basse' : 'Canzone Finta'}`);
}

/** Il link di Telegram del menu aperto. */
function telegramParams() {
  const telegram = [...document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')].find(
    (anchor) => anchor.href.startsWith('https://t.me/share/url'),
  );
  return new URL(telegram?.href ?? 'https://invalid.example').searchParams;
}

/** Il link condiviso, letto dal link di Telegram del menu. */
function sharedLink() {
  return telegramParams().get('url') ?? '';
}

/** I percorsi same-origin scaricati dal menu (l'immagine da allegare). */
function imageRequests() {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), window.location.origin))
    .filter(
      (url) =>
        url.pathname.startsWith('/search/anteprima') || url.pathname.startsWith('/quiz/anteprima'),
    )
    .map((url) => `${url.pathname}${url.search}`);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/search/anteprima.jpg') || url.includes('/quiz/anteprima.jpg')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response(JSON.stringify({ premium: false, signedIn: true, allowed: true }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('YT', {
    Player: function Player() {
      return {
        loadVideoById: vi.fn(),
        cueVideoById: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 200),
        destroy: vi.fn(),
      };
    },
  });
  // Il menu di sistema esiste: l'immagine si prepara all'apertura del menu.
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  Reflect.deleteProperty(navigator, 'share');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('player: "Condividi"', () => {
  it('brano Audius: link con au=<id> e scheda ?au=<id>', async () => {
    await openShareMenu(audius);
    const link = new URL(sharedLink());
    expect(link.pathname).toBe('/search');
    expect(link.searchParams.get('au')).toBe('J7Xb000');
    expect(link.searchParams.get('t')).toBe('Luci basse');
    expect(link.searchParams.has('img')).toBe(false);
    expect(imageRequests()).toEqual(['/search/anteprima.jpg?au=J7Xb000']);
  });

  it('video YouTube: nessun id Audius, scheda ?t=…&a=… dello stesso brano', async () => {
    await openShareMenu(video);
    const link = new URL(sharedLink());
    expect(link.searchParams.has('au')).toBe(false);
    expect(link.searchParams.get('t')).toBe('Canzone Finta');
    expect(link.searchParams.get('a')).toBe('Artista Finto');
    expect(imageRequests()).toEqual(['/search/anteprima.jpg?t=Canzone%20Finta&a=Artista%20Finto']);
  });
});

describe('player: "Sfida un amico"', () => {
  it('brano Audius: quiz /quiz con il codice e au=<id>, scheda ?au=<id>, nessuna risposta', async () => {
    await openFullPlayer(audius);
    await openMenu('Sfida un amico: chi interpreta Luci basse?');
    const link = new URL(sharedLink());
    expect(link.pathname).toBe('/quiz');
    expect([...link.searchParams.keys()]).toEqual(['c', 'au']);
    expect(songQuizFromParams(searchParamsRecord(link.searchParams))).toEqual({
      title: 'Luci basse',
      artist: 'Artista Audius',
      audiusId: 'J7Xb000',
    });
    expect(telegramParams().get('text')).toBe(
      'Sai chi interpreta «Luci basse»? Gira la carta su Solco.',
    );
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')) {
      expect(decodeURIComponent(anchor.href)).not.toContain('Artista Audius');
    }
    expect(imageRequests()).toEqual(['/quiz/anteprima.jpg?au=J7Xb000']);
  });

  it('video YouTube: quiz senza id Audius, scheda ?t=<titolo> senza l’artista', async () => {
    await openFullPlayer(video);
    await openMenu('Sfida un amico: chi interpreta Canzone Finta?');
    const link = new URL(sharedLink());
    expect(link.searchParams.has('au')).toBe(false);
    expect(songQuizFromParams(searchParamsRecord(link.searchParams))).toEqual({
      title: 'Canzone Finta',
      artist: 'Artista Finto',
      audiusId: null,
    });
    expect(imageRequests()).toEqual(['/quiz/anteprima.jpg?t=Canzone%20Finta']);
  });

  it.each([
    ['Laura Pausini: La solitudine (Official Video)', 'Warner Music Italy'],
    ['Adele: Hello (Official Video)', 'AdeleVEVO'],
    ['Hello lyrics', '7clouds'],
    ['Imagine Dragons “Believer”', 'ImagineDragons'],
  ])(
    'video YouTube senza «Artista - Titolo» (%s): "Condividi" sì, "Sfida un amico" no',
    async (title, channelTitle) => {
      // Il canale non è l'artista: la risposta sarebbe sbagliata o già scritta nella domanda.
      await openFullPlayer(
        videoToTrack({ videoId: 'aBcDeFgHiJk', title, channelTitle, thumbnailUrl: null }),
      );
      expect(document.querySelector('button[aria-label^="Condividi "]')).not.toBeNull();
      expect(document.querySelector('button[aria-label^="Sfida un amico"]')).toBeNull();
    },
  );

  it('brano Audius «Artista - Titolo»: la domanda senza la parte con l’artista', async () => {
    await openFullPlayer({
      ...audius,
      title: 'Skrillex - Bangarang (feat. Sirah)',
      artistName: 'Skrillex',
    });
    await openMenu('Sfida un amico: chi interpreta Bangarang?');
    expect(telegramParams().get('text')).toBe(
      'Sai chi interpreta «Bangarang»? Gira la carta su Solco.',
    );
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('[role="menu"] a')) {
      expect(decodeURIComponent(anchor.href).toLowerCase()).not.toContain('skrillex');
    }
  });

  it('brano senza artista: "Condividi" sì, "Sfida un amico" no', async () => {
    await openFullPlayer({ ...audius, artistName: '' });
    expect(document.querySelector('button[aria-label="Condividi Luci basse"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label^="Sfida un amico"]')).toBeNull();
  });
});
