// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  session: { data: null as { user: { id: string } } | null, isPending: false },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => mocks.session }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/navigation', () => ({ usePathname: () => '/playlist/x' }));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));

import { MusicPlayerProvider } from '@/components/custom/music/music-player';
import { SharedPlaylistView } from '@/components/custom/music/shared-playlist-view';
import { isolateName } from '@/lib/music/playlist-share';

const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const SHARED_PATH = `/api/music/shared/${SHARE_ID}`;

const playlist = {
  name: 'Viaggio notturno',
  owner: 'Giulia',
  itemCount: 3,
  updatedAt: '2026-11-10T12:00:00.000Z',
  items: [
    {
      source: 'audius' as const,
      sourceId: 'track-71',
      title: 'Luci basse',
      creatorName: 'Artista Audius',
      artworkUrl: 'https://audius.co/content/abc/480x480.jpg',
      sourceUrl: 'https://audius.co/artista/luci-basse',
      artistUrl: 'https://audius.co/artista',
      durationSeconds: 201,
    },
    {
      source: 'audius' as const,
      sourceId: 'track-72',
      title: 'Alba',
      creatorName: 'Artista Audius',
      artworkUrl: 'https://audius.co/content/def/480x480.jpg',
      sourceUrl: 'https://audius.co/artista/alba',
      artistUrl: 'https://audius.co/artista',
      durationSeconds: 180,
    },
    {
      source: 'youtube' as const,
      sourceId: 'aaaaaaaaaaa',
      title: null,
      creatorName: null,
      artworkUrl: null,
      sourceUrl: null,
      artistUrl: null,
      durationSeconds: null,
    },
  ],
};

function apiError(status: number, cause: unknown) {
  return new Error(`apiFetch failed (${status})`, { cause });
}

const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(shareId = SHARE_ID) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MusicPlayerProvider>
        <SharedPlaylistView shareId={shareId} />
      </MusicPlayerProvider>,
    ),
  );
  await flush();
  return container;
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Pulsante "${label}" non trovato.`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await flush();
}

beforeEach(() => {
  mocks.session = { data: null, isPending: false };
  mocks.toast.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path === SHARED_PATH) return playlist;
    if (/^\/api\/music\/audius\/tracks\/[^/]+\/playback$/.test(path)) return { allowed: true };
    return null;
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pagina pubblica di una playlist condivisa', () => {
  it('mostra lo scheletro di caricamento finché la playlist non arriva', async () => {
    mocks.apiFetch.mockImplementation(() => new Promise(() => undefined));
    const container = await mount();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).toContain('Caricamento della playlist…');
  });

  it('dice che la playlist non è più condivisa (404 o link non valido)', async () => {
    mocks.apiFetch.mockRejectedValue(apiError(404, { error: 'not_found' }));
    const container = await mount();
    expect(container.textContent).toContain('Questa playlist non è più condivisa');

    mocks.apiFetch.mockClear();
    const invalid = await mount('non-valido');
    expect(invalid.textContent).toContain('Questa playlist non è più condivisa');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('con un 429 mostra il messaggio del server, non un problema di connessione', async () => {
    const message = 'Hai raggiunto il limite per le richieste al catalogo. Riprova tra 42 secondi.';
    mocks.apiFetch.mockRejectedValueOnce(apiError(429, { error: 'rate_limited', message }));
    const container = await mount();
    expect(container.textContent).toContain('Non riesco a caricare la playlist');
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('Controlla la connessione');
  });

  it('mostra un errore con "Riprova" e ricarica', async () => {
    mocks.apiFetch.mockRejectedValueOnce(apiError(503, { error: 'shared_playlist_unavailable' }));
    const container = await mount();
    expect(container.textContent).toContain('Non riesco a caricare la playlist');
    expect(container.textContent).toContain('Controlla la connessione');
    const retry = button(container, 'Riprova');
    retry.focus();
    await click(retry);
    expect(container.textContent).toContain('Viaggio notturno');
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === SHARED_PATH)).toHaveLength(2);
    // "Riprova" is gone with the error state: the focus goes to the new heading, not <body>.
    expect(document.activeElement).toBe(container.querySelector('h1'));
  });

  it('mostra intestazione, brani, licenza Audius e invita ad accedere chi non ha un account', async () => {
    const container = await mount();
    expect(container.querySelector('h1')?.textContent).toBe('Viaggio notturno');
    expect(container.textContent).toContain('di Giulia');
    expect(container.textContent).toContain('3 brani');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(container.textContent).toContain('Open Music License');
    expect(container.textContent).toContain('I dettagli di questo video non sono più disponibili.');
    // The expired YouTube item has no play control; the two Audius tracks do.
    expect(container.querySelectorAll('li button')).toHaveLength(2);
    const login = [...container.querySelectorAll('a')].find((link) =>
      link.textContent?.includes('Accedi per ascoltare e salvare'),
    );
    expect(login?.getAttribute('href')).toBe(`/login?callbackURL=%2Fplaylist%2F${SHARE_ID}`);
    expect(container.textContent).not.toContain('Salva nella mia libreria');
    // Truncated titles and artists keep their full text in a tooltip.
    expect(container.querySelector('li strong')?.getAttribute('title')).toBe('Luci basse');
    expect(container.querySelector('[title="Artista Audius"]')).not.toBeNull();
    // "l’" before 8 and 11, "il" otherwise.
    expect(container.textContent).toContain('Aggiornata il 10 novembre 2026.');
    // List semantics survive list-style: none (Safari); the "01" index is not read out.
    expect(container.querySelector('ol')?.getAttribute('role')).toBe('list');
    expect(container.querySelector('li span')?.getAttribute('aria-hidden')).toBe('true');
    // Links that open a new tab say so to screen readers.
    const artist = container.querySelector('a[href="https://audius.co/artista"]');
    expect(artist?.textContent).toContain('(si apre in una nuova scheda)');
    // The sign-in CTA wraps on narrow phones instead of being clipped by the hero.
    expect(login?.className).toContain('whitespace-normal');
  });

  it('scrive "il 1º" per il primo del mese', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === SHARED_PATH ? { ...playlist, updatedAt: '2026-12-01T12:00:00.000Z' } : null,
    );
    const container = await mount();
    expect(container.textContent).toContain('Aggiornata il 1º dicembre 2026.');
  });

  it('elide l’articolo della data davanti a 8 e 11', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === SHARED_PATH ? { ...playlist, updatedAt: '2026-11-11T12:00:00.000Z' } : null,
    );
    const eleven = await mount();
    expect(eleven.textContent).toContain('Aggiornata l’11 novembre 2026.');
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === SHARED_PATH ? { ...playlist, updatedAt: '2026-12-08T12:00:00.000Z' } : null,
    );
    const eight = await mount();
    expect(eight.textContent).toContain('Aggiornata l’8 dicembre 2026.');
  });

  it('chi non ha un account non avvia il player: invita ad accedere e tornare alla playlist', async () => {
    const container = await mount();
    // The sign-in link is the primary action (first in the hero).
    const actions = container.querySelector('header a, header button');
    expect(actions?.textContent).toContain('Accedi per ascoltare e salvare');
    expect(container.textContent).not.toContain('Per ascoltare serve un account gratuito.');

    for (const label of ['Riproduci tutto', 'Casuale', 'Riproduci Alba']) {
      await click(button(container, label));
      expect(container.querySelector('audio')?.getAttribute('src') ?? null).toBeNull();
    }
    expect(
      mocks.apiFetch.mock.calls.some(([path]) => String(path).startsWith('/api/music/audius/')),
    ).toBe(false);

    const prompt = container.querySelector<HTMLElement>(
      'section[aria-labelledby="shared-playlist-auth-title"]',
    );
    expect(prompt?.textContent).toContain('Per ascoltare serve un account gratuito.');
    expect(document.activeElement).toBe(prompt);
    const links = Object.fromEntries(
      [...(prompt?.querySelectorAll('a') ?? [])].map((link) => [
        link.textContent?.trim(),
        link.getAttribute('href'),
      ]),
    );
    expect(links).toEqual({
      'Registrati gratis': `/signup?callbackURL=%2Fplaylist%2F${SHARE_ID}`,
      Accedi: `/login?callbackURL=%2Fplaylist%2F${SHARE_ID}`,
    });
  });

  it('mentre la sessione si verifica non avvia nulla e non chiede di accedere', async () => {
    mocks.session = { data: null, isPending: true };
    const container = await mount();
    const playAll = button(container, 'Riproduci tutto');
    expect(playAll.getAttribute('aria-disabled')).toBe('true');
    expect(button(container, 'Riproduci Alba').getAttribute('aria-disabled')).toBe('true');
    for (const label of ['Riproduci tutto', 'Casuale', 'Riproduci Alba']) {
      await click(button(container, label));
    }
    expect(container.querySelector('audio')?.getAttribute('src') ?? null).toBeNull();
    expect(container.textContent).not.toContain('Per ascoltare serve un account gratuito.');
    expect(
      mocks.apiFetch.mock.calls.some(([path]) => String(path).startsWith('/api/music/audius/')),
    ).toBe(false);
  });

  it('riproduce un brano nel player condiviso con la coda della playlist', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    const container = await mount();
    await click(button(container, 'Riproduci Alba'));
    expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toContain(
      '/api/music/audius/tracks/track-72/playback',
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/track-72/stream',
    );
  });

  it('durante il caricamento il pulsante del brano resta focalizzabile e ignora i clic', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    // play() never settles: the player stays in "loading".
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(new Promise(() => undefined));
    const container = await mount();
    const play = button(container, 'Riproduci Alba');
    play.focus();
    await click(play);
    const loading = button(container, 'Caricamento: Alba');
    expect(loading).toBe(play);
    expect(loading.disabled).toBe(false);
    expect(loading.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(loading);

    const checks = () =>
      mocks.apiFetch.mock.calls.filter(([path]) => String(path).endsWith('/track-72/playback'))
        .length;
    const before = checks();
    await click(loading);
    expect(checks()).toBe(before);
    expect(document.activeElement).toBe(loading);
  });

  it('"Riproduci tutto" parte dal primo brano disponibile', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    const container = await mount();
    await click(button(container, 'Riproduci tutto'));
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/track-71/stream',
    );
  });

  it('"Casuale" mescola la coda prima di partire', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    const container = await mount();
    await click(button(container, 'Casuale'));
    // With Math.random() = 0 the Fisher-Yates shuffle moves the last playable track first.
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/api/music/audius/tracks/track-72/stream',
    );
  });

  it('salva una copia nella Libreria per chi ha un account', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === SHARED_PATH) return playlist;
      if (path === `${SHARED_PATH}/save`)
        return { collectionId: 'copy-1', name: 'Viaggio notturno' };
      return null;
    });
    const container = await mount();
    const save = button(container, 'Salva nella mia libreria');
    save.focus();
    await click(save);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      `${SHARED_PATH}/save`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith(
      `“${isolateName('Viaggio notturno')}” è nella tua Libreria.`,
    );
    const libraryLink = [...container.querySelectorAll('a')].find((link) =>
      link.textContent?.includes('apri la Libreria'),
    );
    expect(libraryLink?.getAttribute('href')).toBe('/library');
    // The button became a link: the focus follows it instead of dropping to <body>.
    expect(document.activeElement).toBe(libraryLink);
  });

  it('mentre salva il pulsante resta focalizzabile e non invia due richieste', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === SHARED_PATH) return playlist;
      if (path === `${SHARED_PATH}/save`) return new Promise(() => undefined);
      return null;
    });
    const container = await mount();
    const save = button(container, 'Salva nella mia libreria');
    save.focus();
    await click(save);
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(save);
    await click(save);
    expect(
      mocks.apiFetch.mock.calls.filter(([path]) => path === `${SHARED_PATH}/save`),
    ).toHaveLength(1);
  });

  it('al proprietario dice che la playlist è già nella sua Libreria', async () => {
    mocks.session = { data: { user: { id: 'owner' } }, isPending: false };
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === SHARED_PATH) return playlist;
      if (path === `${SHARED_PATH}/save`) {
        throw apiError(409, {
          error: 'own_playlist',
          message: 'Questa playlist è già nella tua Libreria.',
        });
      }
      return null;
    });
    const container = await mount();
    await click(button(container, 'Salva nella mia libreria'));
    expect(mocks.toast).toHaveBeenCalledWith('Questa playlist è già nella tua Libreria.');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('mostra il messaggio del server quando il limite di playlist è raggiunto', async () => {
    mocks.session = { data: { user: { id: 'friend' } }, isPending: false };
    const message =
      'Hai raggiunto il limite di 100 playlist. Eliminane una per salvarne una nuova.';
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === SHARED_PATH) return playlist;
      if (path === `${SHARED_PATH}/save`) throw apiError(409, { error: 'limit_reached', message });
      return null;
    });
    const container = await mount();
    await click(button(container, 'Salva nella mia libreria'));
    expect(mocks.toast.error).toHaveBeenCalledWith(message);
    expect(container.textContent).toContain('Salva nella mia libreria');
  });
});
