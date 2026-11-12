// @polsia:user-owned — scheda "Importa da Spotify" nella Libreria (UI, apiFetch simulato).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { SpotifyImport } from '@/components/custom/music/spotify-import';

type Init = RequestInit & { schema?: ZodType<unknown> };
type Handler = (path: string, init: Init | undefined) => unknown;

/** A valid Spotify id (base62, 22 characters). */
const spotifyId = (n: number) => `PlaylistId${String(n).padStart(12, '0')}`;

function playlist(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: spotifyId(n),
    name: `Playlist ${n}`,
    owner: `Utente ${n}`,
    imageUrl: `https://i.scdn.co/image/cover-${n}`,
    itemCount: 10 + n,
    spotifyUrl: `https://open.spotify.com/playlist/${spotifyId(n)}`,
    importable: true,
    ...overrides,
  };
}

function page(count: number, nextOffset: number | null = null, from = 1) {
  return {
    playlists: Array.from({ length: count }, (_, index) => playlist(from + index)),
    savedTracks: 42,
    nextOffset,
  };
}

/** Same failure shape as the real apiFetch: status in the message, JSON body as `cause`. */
function httpError(path: string, status: number, body: Record<string, unknown>) {
  return new Error(`apiFetch ${path} failed (${status})`, { cause: body });
}

let handler: Handler;
const roots: Array<ReturnType<typeof createRoot>> = [];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function mount(onImported = vi.fn()) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SpotifyImport onImported={onImported} />));
  await flush();
  return { container, onImported };
}

function byText<T extends HTMLElement>(container: HTMLElement, selector: string, text: string) {
  const match = [...container.querySelectorAll<T>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!match) throw new Error(`${selector} con testo "${text}" non trovato.`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function openChooser(container: HTMLElement) {
  await click(byText(container, 'button', 'Scegli le playlist'));
}

function checkbox(container: HTMLElement, label: string) {
  const labelElement = byText<HTMLLabelElement>(container, 'label', label);
  const input = container.querySelector<HTMLInputElement>(
    `input[id="${labelElement.htmlFor.replace(/"/g, '\\"')}"]`,
  );
  if (!input) throw new Error(`Casella per "${label}" non trovata.`);
  return input;
}

function connected(playlists = page(3)): Handler {
  return (path) => {
    if (path === '/api/spotify/connection') return { configured: true, connected: true };
    if (path.startsWith('/api/spotify/playlists')) return playlists;
    throw new Error(`Percorso inatteso: ${path}`);
  };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/library');
  mocks.success.mockReset();
  mocks.error.mockReset();
  handler = () => ({ configured: true, connected: false });
  mocks.apiFetch.mockReset().mockImplementation(async (path: string, init?: Init) => {
    const body = handler(path, init);
    // Run the real contract like apiFetch does, so the fixtures stay honest.
    return init?.schema ? init.schema.parse(body) : body;
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const paths = () => mocks.apiFetch.mock.calls.map(([path]) => path as string);

describe('Importa da Spotify — stato della connessione', () => {
  it('non mostra nulla quando Spotify non è configurato', async () => {
    handler = () => ({ configured: false, connected: false });
    const { container } = await mount();
    expect(container.innerHTML).toBe('');
    expect(paths()).toEqual(['/api/spotify/connection']);
  });

  it('non mostra nulla se la connessione non si può leggere', async () => {
    handler = (path) => {
      throw httpError(path, 401, { error: 'unauthorized', message: 'Accedi.' });
    };
    const { container } = await mount();
    expect(container.innerHTML).toBe('');
  });

  it('da scollegato mostra il logo ufficiale e un link (non fetch) al login Spotify', async () => {
    const { container } = await mount();
    expect(container.textContent).toContain(
      'Porta in Solco le tue playlist Spotify e i brani salvati.',
    );
    const login = byText<HTMLAnchorElement>(container, 'a', 'Accedi con Spotify');
    expect(login.getAttribute('href')).toBe('/api/spotify/login');
    expect(login.target).toBe('');
    const logos = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(logos).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/brand/spotify/full-logo-white.svg'),
        expect.stringContaining('/brand/spotify/full-logo-black.svg'),
      ]),
    );
    expect(container.querySelector('img[alt="Spotify"]')).not.toBeNull();
    // Nothing is read from Spotify before the user connects.
    expect(paths()).toEqual(['/api/spotify/connection']);
  });
});

describe('Importa da Spotify — scelta delle playlist', () => {
  it('legge le playlist solo quando si apre la scelta e le attribuisce a Spotify', async () => {
    handler = connected(page(3, 20));
    const { container } = await mount();
    expect(paths()).toEqual(['/api/spotify/connection']);
    expect(container.textContent).toContain('Dati forniti da Spotify');

    await openChooser(container);
    expect(paths()).toContain('/api/spotify/playlists?offset=0');

    const name = byText(container, 'span[title]', 'Playlist 2');
    expect(name.getAttribute('title')).toBe('Playlist 2');
    expect(container.textContent).toContain('di Utente 2 · 12 brani');
    expect(container.textContent).toContain('Brani salvati (42)');
    expect(container.querySelector('legend')?.textContent).toBe('Cosa vuoi importare?');

    const cover = container.querySelector('img[src*="i.scdn.co/image/cover-1"]');
    expect(cover?.getAttribute('alt')).toBe('');

    const links = [...container.querySelectorAll<HTMLAnchorElement>('a')].filter((link) =>
      link.textContent?.includes('Apri in Spotify'),
    );
    // Saved songs + one per playlist, each back to Spotify in a new tab.
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://open.spotify.com/collection/tracks',
      `https://open.spotify.com/playlist/${spotifyId(1)}`,
      `https://open.spotify.com/playlist/${spotifyId(2)}`,
      `https://open.spotify.com/playlist/${spotifyId(3)}`,
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noopener');
      expect(link.querySelector('img[src*="primary-logo"]')).not.toBeNull();
    }
    const openSpotify = byText<HTMLAnchorElement>(container, 'a', 'Apri Spotify');
    expect(openSpotify.getAttribute('href')).toBe('https://open.spotify.com');
    expect(
      byText(container, 'footer', 'Dati forniti da Spotify').querySelector(
        'img[src*="primary-logo"]',
      ),
    ).not.toBeNull();
  });

  it('mostra al massimo 20 playlist per pagina e sfoglia con "Altre playlist"', async () => {
    handler = (path) => {
      if (path === '/api/spotify/connection') return { configured: true, connected: true };
      if (path === '/api/spotify/playlists?offset=0') return page(20, 20);
      if (path === '/api/spotify/playlists?offset=20') return page(2, null, 21);
      throw new Error(path);
    };
    const { container } = await mount();
    await openChooser(container);
    expect(container.querySelectorAll('ul li')).toHaveLength(20);

    await click(byText(container, 'button', 'Altre playlist'));
    expect(paths()).toContain('/api/spotify/playlists?offset=20');
    expect(container.textContent).toContain('Playlist 22');
    expect(container.textContent).not.toContain('Playlist 20');
    expect(container.textContent).not.toContain('Altre playlist');
    expect(document.activeElement?.tagName).toBe('UL');

    await click(byText(container, 'button', 'Playlist precedenti'));
    expect(container.textContent).toContain('Playlist 20');
  });

  it('non segue link che non portano a open.spotify.com', async () => {
    handler = connected({
      playlists: [playlist(1, { spotifyUrl: 'javascript:alert(1)', owner: null, imageUrl: null })],
      savedTracks: 0,
      nextOffset: null,
    });
    const { container } = await mount();
    await openChooser(container);
    const link = byText<HTMLAnchorElement>(container, 'li a', 'Apri in Spotify');
    expect(link.getAttribute('href')).toBe(`https://open.spotify.com/playlist/${spotifyId(1)}`);
    expect(container.textContent).not.toContain('di null');
  });

  it('consente al massimo 5 scelte (i brani salvati contano come una)', async () => {
    handler = connected(page(6));
    const { container } = await mount();
    await openChooser(container);

    await click(checkbox(container, 'Brani salvati'));
    for (const n of [1, 2, 3, 4]) await click(checkbox(container, `Playlist ${n}`));

    expect(checkbox(container, 'Playlist 5').disabled).toBe(true);
    expect(checkbox(container, 'Playlist 6').disabled).toBe(true);
    expect(checkbox(container, 'Playlist 1').disabled).toBe(false);
    expect(container.textContent).toContain('il massimo per un’importazione');

    await click(checkbox(container, 'Brani salvati'));
    expect(checkbox(container, 'Playlist 5').disabled).toBe(false);
    await click(checkbox(container, 'Playlist 5'));
    expect(checkbox(container, 'Brani salvati').disabled).toBe(true);
  });

  it('mostra le playlist soltanto seguite senza poterle scegliere', async () => {
    handler = connected({
      playlists: [
        playlist(1),
        playlist(2, { name: 'Today’s Top Hits', owner: 'Spotify', importable: false }),
        playlist(3),
        playlist(4),
        playlist(5),
      ],
      savedTracks: 42,
      nextOffset: null,
    });
    const { container } = await mount();
    expect(container.textContent).toContain(
      'le playlist che hai creato o di cui sei collaboratore',
    );
    await openChooser(container);

    const followed = checkbox(container, 'Today’s Top Hits');
    expect(followed.disabled).toBe(true);
    const row = followed.closest('li');
    // Marked for the CSS (dashed border); the artwork itself is never faded.
    expect(row?.getAttribute('data-importable')).toBe('false');
    expect(checkbox(container, 'Playlist 1').closest('li')?.hasAttribute('data-importable')).toBe(
      false,
    );
    expect(row?.textContent).toContain(
      'Non importabile: Spotify consente di importare solo le playlist create da te o di cui sei collaboratore.',
    );
    // The note is inside the label, so it is part of the checkbox's accessible name.
    expect(byText<HTMLLabelElement>(container, 'label', 'Today’s Top Hits').textContent).toContain(
      'Non importabile',
    );
    // The link back to Spotify stays.
    expect(row?.querySelector('a')?.getAttribute('href')).toBe(
      `https://open.spotify.com/playlist/${spotifyId(2)}`,
    );
    await click(followed);
    expect(followed.checked).toBe(false);
    // Importable rows are unaffected and carry no note.
    expect(checkbox(container, 'Playlist 1').disabled).toBe(false);
    expect(checkbox(container, 'Playlist 1').closest('li')?.textContent).not.toContain(
      'Non importabile',
    );

    // Five real choices fill the import; the followed one never counted.
    await click(checkbox(container, 'Brani salvati'));
    for (const n of [1, 3, 4, 5]) await click(checkbox(container, `Playlist ${n}`));
    expect(container.textContent).toContain('Scelti 5 di 5');
    expect(followed.disabled).toBe(true);
  });

  it('mostra il messaggio del server con i secondi quando Spotify risponde 429', async () => {
    handler = (path) => {
      if (path === '/api/spotify/connection') return { configured: true, connected: true };
      throw httpError(path, 429, {
        error: 'spotify_rate_limited',
        message: 'Spotify sta ricevendo troppe richieste.',
        retryAfterSeconds: 12,
      });
    };
    const { container } = await mount();
    await openChooser(container);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Spotify sta ricevendo troppe richieste.');
    expect(alert?.textContent).toContain('Riprova tra 12 secondi.');
  });

  it('mostra il messaggio italiano del server per un account non abilitato (403)', async () => {
    handler = (path) => {
      if (path === '/api/spotify/connection') return { configured: true, connected: true };
      throw httpError(path, 403, {
        error: 'spotify_not_allowlisted',
        message: 'Questo account Spotify non è tra i 5 tester autorizzati.',
      });
    };
    const { container } = await mount();
    await openChooser(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Questo account Spotify non è tra i 5 tester autorizzati.',
    );
    expect(byText(container, 'button', 'Riprova')).toBeTruthy();
  });
});

describe('Importa da Spotify — importazione e disconnessione', () => {
  it('importa le scelte con POST, avvisa con i conteggi e ricarica la Libreria', async () => {
    let body: unknown = null;
    const list = page(3);
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        body = JSON.parse(String(init?.body));
        expect(init?.method).toBe('POST');
        return {
          created: [
            {
              collectionId: 'c1',
              name: 'Playlist 1',
              imported: 120,
              skipped: 3,
              truncated: 0,
              source: spotifyId(1),
            },
            {
              collectionId: 'c2',
              name: 'Brani salvati su Spotify',
              imported: 200,
              skipped: 0,
              truncated: 50,
              source: 'saved',
            },
          ],
          failed: [
            {
              source: spotifyId(3),
              error: 'spotify_forbidden',
              message: 'Spotify non consente di leggere questa playlist.',
            },
          ],
        };
      }
      return connected(list)(path, init);
    };
    const { container, onImported } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 1'));
    await click(checkbox(container, 'Playlist 3'));
    await click(checkbox(container, 'Brani salvati'));
    await click(byText(container, 'button', 'Importa in Solco'));

    expect(body).toEqual({ playlistIds: [spotifyId(1), spotifyId(3)], saved: true });
    expect(mocks.success).toHaveBeenCalledWith(
      '2 playlist importate in Solco: 320 brani in tutto.',
    );
    expect(mocks.error).toHaveBeenCalledWith('Spotify non consente di leggere questa playlist.');
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('“Playlist 1”: 120 brani (3 saltati)');
    expect(container.textContent).toContain(
      '“Brani salvati su Spotify”: 200 brani (50 oltre il limite di 200)',
    );
    expect(container.textContent).toContain('“Playlist 3”: non importata.');
    expect(checkbox(container, 'Playlist 1').checked).toBe(false);
    expect(container.querySelector('output')?.textContent).toBe('Importazione completata.');
  });

  it('chiede di ricollegare Spotify quando il server risponde spotify_reauth', async () => {
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        throw httpError(path, 401, {
          error: 'spotify_reauth',
          message: 'Ricollega Spotify per continuare.',
        });
      }
      return connected()(path, init);
    };
    const { container, onImported } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 2'));
    await click(byText(container, 'button', 'Importa in Solco'));

    const relink = byText<HTMLAnchorElement>(container, 'a', 'Ricollega Spotify');
    expect(relink.getAttribute('href')).toBe('/api/spotify/login');
    expect(container.textContent).not.toContain('Playlist 2');
    expect(mocks.error).toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('con un consenso precedente chiede di ricollegare Spotify e consente di scollegarlo', async () => {
    let deleted = false;
    handler = (path, init) => {
      if (path === '/api/spotify/connection' && init?.method === 'DELETE') {
        deleted = true;
        return { configured: true, connected: false, needsReconnect: false };
      }
      if (path === '/api/spotify/connection') {
        return { configured: true, connected: true, needsReconnect: true };
      }
      throw new Error(`Percorso inatteso: ${path}`);
    };
    const { container } = await mount();
    expect(container.textContent).toContain(
      'Spotify è collegato con un consenso precedente, che non include le playlist di cui sei collaboratore.',
    );
    expect(container.textContent).not.toContain('scaduta o è stata revocata');
    expect(
      byText<HTMLAnchorElement>(container, 'a', 'Ricollega Spotify').getAttribute('href'),
    ).toBe('/api/spotify/login');
    // No chooser and no read from Spotify with the old consent.
    expect(container.textContent).not.toContain('Scegli le playlist');
    expect(paths()).toEqual(['/api/spotify/connection']);

    await click(byText(container, 'button', 'Disconnetti Spotify'));
    expect(deleted).toBe(true);
    expect(byText<HTMLAnchorElement>(container, 'a', 'Accedi con Spotify')).toBeTruthy();
  });

  it('passa a "Ricollega Spotify" se il server segnala un consenso precedente', async () => {
    const message =
      'Ricollega Spotify per vedere anche le playlist di cui sei collaboratore: il consenso che hai dato a Solco in precedenza non le include.';
    handler = (path) => {
      if (path === '/api/spotify/connection') return { configured: true, connected: true };
      throw httpError(path, 401, { error: 'spotify_scope_outdated', message });
    };
    const { container } = await mount();
    await openChooser(container);
    expect(mocks.error).toHaveBeenCalledWith(message);
    expect(byText<HTMLAnchorElement>(container, 'a', 'Ricollega Spotify')).toBeTruthy();
    expect(byText<HTMLButtonElement>(container, 'button', 'Disconnetti Spotify')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('se Spotify revoca l’accesso a metà importazione chiede di ricollegarlo', async () => {
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        return {
          created: [
            {
              collectionId: 'c1',
              name: 'Playlist 1',
              imported: 10,
              skipped: 0,
              truncated: 0,
              source: spotifyId(1),
            },
          ],
          failed: [
            {
              source: spotifyId(2),
              error: 'spotify_reauth',
              message: 'Il collegamento con Spotify è scaduto o è stato revocato.',
            },
          ],
        };
      }
      return connected()(path, init);
    };
    const { container, onImported } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 1'));
    await click(checkbox(container, 'Playlist 2'));
    await click(byText(container, 'button', 'Importa in Solco'));

    expect(onImported).toHaveBeenCalledTimes(1);
    expect(mocks.success).toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      'Il collegamento con Spotify è scaduto o è stato revocato.',
    );
    const relink = byText<HTMLAnchorElement>(container, 'a', 'Ricollega Spotify');
    expect(relink.getAttribute('href')).toBe('/api/spotify/login');
    expect(container.textContent).not.toContain('Disconnetti Spotify');
  });

  it('mostra il messaggio del server quando si supera il tetto di playlist (409)', async () => {
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        throw httpError(path, 409, {
          error: 'limit_reached',
          message: 'Hai raggiunto il limite di 100 playlist.',
        });
      }
      return connected()(path, init);
    };
    const { container } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 1'));
    await click(byText(container, 'button', 'Importa in Solco'));
    expect(mocks.error).toHaveBeenCalledWith('Hai raggiunto il limite di 100 playlist.');
  });

  it('scollega Spotify con DELETE e indica dove revocare l’accesso', async () => {
    let deleted = false;
    handler = (path, init) => {
      if (path === '/api/spotify/connection' && init?.method === 'DELETE') {
        deleted = true;
        return { configured: true, connected: false };
      }
      return connected()(path, init);
    };
    const { container } = await mount();
    await click(byText(container, 'button', 'Disconnetti Spotify'));

    expect(deleted).toBe(true);
    expect(mocks.success).toHaveBeenCalledWith('Spotify scollegato.');
    expect(byText<HTMLAnchorElement>(container, 'a', 'Accedi con Spotify')).toBeTruthy();
    const apps = byText<HTMLAnchorElement>(container, 'a', 'spotify.com/account/apps');
    expect(apps.getAttribute('href')).toBe('https://www.spotify.com/account/apps/');
    expect(container.textContent).not.toContain('Dati forniti da Spotify');
  });
});

describe('Importa da Spotify — ritorno da Spotify', () => {
  it('conferma il collegamento, apre la scelta e pulisce l’indirizzo', async () => {
    window.history.replaceState(null, '', '/library?tab=playlist&spotify=connected#top');
    handler = connected();
    const { container } = await mount();
    expect(mocks.success).toHaveBeenCalledWith('Spotify collegato.');
    expect(window.location.search).toBe('?tab=playlist');
    expect(window.location.hash).toBe('#top');
    expect(paths()).toContain('/api/spotify/playlists?offset=0');
    expect(container.textContent).toContain('Playlist 1');
  });

  it('spiega in italiano il motivo di un errore e ignora motivi sconosciuti', async () => {
    window.history.replaceState(null, '', '/library?spotify=error&reason=denied');
    await mount();
    expect(mocks.error).toHaveBeenCalledWith(
      'Hai annullato il collegamento: Spotify non ha condiviso nessun dato.',
    );
    expect(window.location.search).toBe('');

    mocks.error.mockReset();
    window.history.replaceState(null, '', '/library?spotify=error&reason=%3Cscript%3E');
    await mount();
    expect(mocks.error).toHaveBeenCalledWith('Collegamento a Spotify non riuscito. Riprova.');
    expect(window.location.search).toBe('');
  });
});

describe('Importa da Spotify — pagine non caricate e Retry-After', () => {
  const listLabel = (container: HTMLElement) =>
    container.querySelector('ul[aria-label^="Le tue playlist"]')?.getAttribute('aria-label');

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await flush();
  }

  it('dopo una pagina non caricata sfoglia ancora e l’etichetta segue le playlist mostrate', async () => {
    const calls: Record<string, number> = {};
    const unavailable = (path: string) =>
      httpError(path, 503, {
        error: 'spotify_unavailable',
        message: 'Spotify non risponde al momento.',
      });
    handler = (path) => {
      if (path === '/api/spotify/connection') return { configured: true, connected: true };
      calls[path] = (calls[path] ?? 0) + 1;
      if (path === '/api/spotify/playlists?offset=0') {
        if (calls[path] === 2) throw unavailable(path);
        return page(20, 20);
      }
      if (path === '/api/spotify/playlists?offset=20') {
        if (calls[path] === 1) throw unavailable(path);
        return page(2, null, 21);
      }
      throw new Error(path);
    };
    const { container } = await mount();
    await openChooser(container);

    // offset=20 fails: playlists 1-20 stay, labelled as such, and the pager still works.
    await click(byText(container, 'button', 'Altre playlist'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Spotify non risponde al momento.',
    );
    expect(listLabel(container)).toBe('Le tue playlist Spotify, da 1 a 20');
    expect(container.textContent).toContain('Playlist 20');
    expect(container.textContent).not.toContain('Playlist precedenti');

    await click(byText(container, 'button', 'Altre playlist'));
    expect(calls['/api/spotify/playlists?offset=20']).toBe(2);
    expect(listLabel(container)).toBe('Le tue playlist Spotify, da 21 a 22');
    expect(container.textContent).toContain('Playlist 22');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Going back fails once, then works.
    await click(byText(container, 'button', 'Playlist precedenti'));
    expect(calls['/api/spotify/playlists?offset=0']).toBe(2);
    expect(listLabel(container)).toBe('Le tue playlist Spotify, da 21 a 22');
    expect(container.textContent).not.toContain('Playlist 20');

    await click(byText(container, 'button', 'Playlist precedenti'));
    expect(calls['/api/spotify/playlists?offset=0']).toBe(3);
    expect(listLabel(container)).toBe('Le tue playlist Spotify, da 1 a 20');
    expect(container.textContent).toContain('Playlist 20');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('dopo un 429 non richiama Spotify finché non è passato Retry-After', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    handler = (path) => {
      if (path === '/api/spotify/connection') return { configured: true, connected: true };
      attempts += 1;
      if (attempts === 1) {
        throw httpError(path, 429, {
          error: 'spotify_rate_limited',
          message: 'Spotify sta limitando le richieste di Solco. Riprova tra 30 secondi.',
          retryAfterSeconds: 30,
        });
      }
      return page(2);
    };
    const { container } = await mount();
    await openChooser(container);
    const retry = () => byText<HTMLButtonElement>(container, 'button', 'Riprova');
    const alertText = () => container.querySelector('[role="alert"]')?.textContent;

    expect(attempts).toBe(1);
    expect(alertText()).toContain('Riprova tra 30 secondi.');
    expect(retry().disabled).toBe(true);
    await click(retry());
    expect(attempts).toBe(1);

    // Closing and reopening the chooser does not call Spotify during the wait either.
    await click(byText(container, 'button', 'Nascondi le playlist'));
    await openChooser(container);
    expect(attempts).toBe(1);
    expect(alertText()).toContain('Riprova tra 30 secondi.');
    expect(retry().disabled).toBe(true);

    await advance(29_000);
    expect(retry().disabled).toBe(true);
    await advance(1_000);
    expect(retry().disabled).toBe(false);
    // No automatic retry once the wait is over: the user decides.
    expect(attempts).toBe(1);

    await click(retry());
    expect(attempts).toBe(2);
    expect(container.textContent).toContain('Playlist 2');
    expect(alertText()).toBeUndefined();
  });

  it('dopo un 429 dell’importazione tiene fermi Importa e le pagine fino a Retry-After', async () => {
    vi.useFakeTimers();
    let imports = 0;
    const message = 'Spotify sta limitando le richieste di Solco. Riprova tra 20 secondi.';
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        imports += 1;
        throw httpError(path, 429, {
          error: 'spotify_rate_limited',
          message,
          retryAfterSeconds: 20,
        });
      }
      return connected(page(3, 20))(path, init);
    };
    const { container } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 1'));
    await click(byText(container, 'button', 'Importa in Solco'));
    expect(mocks.error).toHaveBeenCalledWith(message);

    const importButton = () => byText<HTMLButtonElement>(container, 'button', 'Importa in Solco');
    const more = () => byText<HTMLButtonElement>(container, 'button', 'Altre playlist');
    expect(importButton().disabled).toBe(true);
    expect(more().disabled).toBe(true);
    // The wait stays on screen after the toast is gone.
    expect(container.textContent).toContain('Riprova tra 20 secondi.');
    await click(importButton());
    expect(imports).toBe(1);

    await advance(20_000);
    expect(importButton().disabled).toBe(false);
    expect(more().disabled).toBe(false);
    expect(container.textContent).not.toContain('Riprova tra 20 secondi.');
    expect(imports).toBe(1);
  });

  it('il limite di importazioni di Solco ferma solo Importa: la lista resta sfogliabile', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 10, 0, 0));
    let imports = 0;
    const lists: string[] = [];
    const message =
      'Hai raggiunto il limite per l’importazione di playlist. Riprova tra 586 secondi.';
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        imports += 1;
        if (imports === 1) {
          throw httpError(path, 429, { error: 'rate_limited', message, retryAfterSeconds: 586 });
        }
        return {
          created: [
            {
              collectionId: 'col-1',
              name: 'Playlist 1',
              imported: 11,
              skipped: 0,
              truncated: 0,
              source: spotifyId(1),
            },
          ],
          failed: [],
        };
      }
      if (path.startsWith('/api/spotify/playlists')) lists.push(path);
      if (path === '/api/spotify/playlists?offset=20') return page(2, null, 21);
      return connected(page(3, 20))(path, init);
    };
    const { container } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 1'));
    await click(byText(container, 'button', 'Importa in Solco'));
    expect(mocks.error).toHaveBeenCalledWith(message);

    const importButton = () => byText<HTMLButtonElement>(container, 'button', 'Importa in Solco');
    expect(importButton().disabled).toBe(true);
    expect(container.textContent).toContain(
      'Hai raggiunto il limite di importazioni: potrai importare di nuovo dalle 10:10.',
    );
    // The selection is kept and the list is still there, with a working pager.
    expect(checkbox(container, 'Playlist 1').checked).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const more = byText<HTMLButtonElement>(container, 'button', 'Altre playlist');
    expect(more.disabled).toBe(false);
    await click(more);
    expect(lists).toContain('/api/spotify/playlists?offset=20');
    expect(container.textContent).toContain('Playlist 22');
    await click(byText(container, 'button', 'Playlist precedenti'));

    // Closing and reopening the chooser loads the list again.
    const before = lists.length;
    await click(byText(container, 'button', 'Nascondi le playlist'));
    await openChooser(container);
    expect(lists.length).toBe(before + 1);
    expect(container.textContent).toContain('Playlist 3');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // "Importa in Solco" stays off until Retry-After, then works again.
    expect(checkbox(container, 'Playlist 1').checked).toBe(true);
    await click(importButton());
    expect(imports).toBe(1);
    await advance(585_000);
    expect(importButton().disabled).toBe(true);
    await advance(1_000);
    expect(importButton().disabled).toBe(false);
    expect(container.textContent).not.toContain('Hai raggiunto il limite di importazioni');
    await click(importButton());
    expect(imports).toBe(2);
    expect(mocks.success).toHaveBeenCalledWith('“Playlist 1” importata in Solco: 11 brani.');
  });

  it('per un’attesa sotto il minuto non mostra secondi che non si aggiornano', async () => {
    vi.useFakeTimers();
    handler = (path, init) => {
      if (path === '/api/spotify/import') {
        throw httpError(path, 429, {
          error: 'rate_limited',
          message:
            'Hai raggiunto il limite per l’importazione di playlist. Riprova tra 30 secondi.',
          retryAfterSeconds: 30,
        });
      }
      return connected()(path, init);
    };
    const { container } = await mount();
    await openChooser(container);
    await click(checkbox(container, 'Playlist 1'));
    await click(byText(container, 'button', 'Importa in Solco'));
    expect(container.textContent).toContain(
      'Hai raggiunto il limite di importazioni: potrai importare di nuovo tra meno di un minuto.',
    );
    expect(container.textContent).not.toMatch(/importare di nuovo tra \d+ second/);
    await advance(30_000);
    expect(byText<HTMLButtonElement>(container, 'button', 'Importa in Solco').disabled).toBe(false);
    expect(container.textContent).not.toContain('Hai raggiunto il limite di importazioni');
  });
});
