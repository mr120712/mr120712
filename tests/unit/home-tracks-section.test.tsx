// @polsia:user-owned — sezione «In evidenza» della Home: controlla solo la versione del catalogo
// (ogni 30 s a scheda visibile, al ritorno sulla scheda, mai in background), riscarica l'elenco per
// versione solo quando cambia (niente ?t=), riserva senza versione più lenta, nessuno sfarfallio,
// player intatto; sezioni, copertine, link d'artista. Più: una richiesta bloccata si interrompe
// dopo ~10 s (gli aggiornamenti non si fermano), mai indietro a una versione più vecchia
// (`listedAt`), un elenco vuoto non definitivo non nasconde i brani già mostrati.
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), playTrack: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: null,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: vi.fn(),
  }),
}));

import { HomeTracksSection } from '@/components/custom/music/home-tracks-section';

function item(id: string, title: string) {
  return {
    id,
    title,
    artist: null,
    streamUrl: `/api/music/home-tracks/stream?p=${id}`,
    durationSeconds: 0,
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<HomeTracksSection />));
  return container;
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
}

const VERSION_URL = '/api/music/home-tracks/version';
const V1 = 'a'.repeat(16);
const V2 = 'b'.repeat(16);

type Listing = { items: unknown[]; sections?: unknown[]; version?: string; listedAt?: string };

/** Lo "server": versione attuale (o errore) ed elenco per URL. */
const server = {
  version: V1 as string,
  versionFails: false,
  listing: (_url: string): Listing | Promise<Listing> => ({ items: [] }),
};

function serve(listing: Listing | ((url: string) => Listing | Promise<Listing>), version = V1) {
  server.version = version;
  server.versionFails = false;
  server.listing = typeof listing === 'function' ? listing : () => listing;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === VERSION_URL) {
      if (server.versionFails) throw new Error(`apiFetch ${url} failed (503)`);
      return { version: server.version, updatedAt: '2026-11-15T10:00:00.000Z' };
    }
    if (url.startsWith('/api/music/home-tracks')) return server.listing(url);
    throw new Error(`URL inattesa: ${url}`);
  });
}

/** L'elenco della versione chiesta nell'URL (?v=), come lo manda il server. */
function versioned(items: unknown[]) {
  return (url: string): Listing => {
    const version = new URL(url, 'https://solco.test').searchParams.get('v');
    return version ? { items, version } : { items, version: server.version };
  };
}

function calls() {
  return mocks.apiFetch.mock.calls.map(([url]) => String(url));
}
function versionCalls() {
  return calls().filter((url) => url === VERSION_URL);
}
function listingCalls() {
  return calls().filter((url) => url.startsWith('/api/music/home-tracks') && url !== VERSION_URL);
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe('HomeTracksSection: aggiornamento automatico per versione', () => {
  it('primo caricamento: prima la versione, poi l’elenco di QUELLA versione (in cache CDN)', async () => {
    serve(versioned([item('a.mp3', 'Primo'), item('b.mp3', 'Secondo')]));
    render();
    await flush();
    expect(calls()).toEqual([VERSION_URL, `/api/music/home-tracks?v=${V1}`]);
    const text = container.textContent ?? '';
    expect(text).toContain('Primo');
    expect(text).toContain('Secondo');
    expect(text).toContain('IN EVIDENZA');
  });

  it('controlla la versione ogni 30 secondi e riscarica l’elenco SOLO quando cambia', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    render();
    await flush();
    expect(listingCalls()).toHaveLength(1);

    await advance(30_000);
    expect(versionCalls()).toHaveLength(2);
    expect(listingCalls()).toHaveLength(1);

    // L'amministratore carica un brano: cambia la versione.
    server.version = V2;
    server.listing = versioned([item('nuovo.mp3', 'Nuovo'), item('a.mp3', 'Primo')]);
    await advance(30_000);
    expect(versionCalls()).toHaveLength(3);
    expect(listingCalls()).toEqual([
      `/api/music/home-tracks?v=${V1}`,
      `/api/music/home-tracks?v=${V2}`,
    ]);
    expect(container.textContent).toContain('Nuovo');

    // Versione invariata: nessun altro elenco.
    await advance(30_000);
    expect(listingCalls()).toHaveLength(2);
    // Mai query-string per aggirare la cache.
    expect(calls().some((url) => url.includes('?t=') || url.includes('&t='))).toBe(false);
  });

  it('scheda in background: nessuna richiesta; al ritorno un solo controllo (focus + visibilitychange)', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    render();
    await flush();
    const before = calls().length;

    setVisibility('hidden');
    await advance(5 * 60_000);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(calls().length).toBe(before);

    setVisibility('visible');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await flush();
    expect(versionCalls()).toHaveLength(2);
    // Stessa versione: niente elenco.
    expect(listingCalls()).toHaveLength(1);
  });

  it('non ricontrolla dentro la finestra di throttle', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    render();
    await flush();
    const before = calls().length;
    await act(async () => {
      vi.advanceTimersByTime(3000); // < throttle
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await flush();
    expect(calls().length).toBe(before);
  });

  it('versione non disponibile: riserva all’elenco senza versione, più di rado (2 minuti)', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    server.versionFails = true;
    render();
    await flush();
    expect(calls()).toEqual([VERSION_URL, '/api/music/home-tracks']);
    expect(container.textContent).toContain('Primo');

    // Né il controllo periodico né il ritorno sulla scheda insistono prima di 2 minuti.
    await advance(30_000);
    await advance(30_000);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(calls()).toHaveLength(2);

    await advance(60_000);
    expect(calls()).toEqual([
      VERSION_URL,
      '/api/music/home-tracks',
      VERSION_URL,
      '/api/music/home-tracks',
    ]);

    // La versione torna: è quella già mostrata (riportata dall'elenco), nessun elenco in più; si
    // torna al ritmo normale.
    server.versionFails = false;
    await advance(120_000);
    expect(versionCalls()).toHaveLength(3);
    expect(listingCalls()).toHaveLength(2);
    await advance(30_000);
    expect(versionCalls()).toHaveLength(4);
  });

  it('contenuto non definitivo (senza `version`): lo richiede al controllo successivo', async () => {
    let definitive = false;
    serve((url) => ({
      items: [
        {
          ...item('a.mp3', 'Primo'),
          artist: 'Lucio Dalla',
          artistSlug: definitive ? 'lucio-dalla' : null,
        },
      ],
      ...(definitive
        ? { version: new URL(url, 'https://solco.test').searchParams.get('v') ?? V1 }
        : {}),
    }));
    render();
    await flush();
    expect(container.querySelector('a')).toBeNull();

    definitive = true;
    await advance(30_000);
    expect(listingCalls()).toEqual([
      `/api/music/home-tracks?v=${V1}`,
      `/api/music/home-tracks?v=${V1}`,
    ]);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/artista/lucio-dalla');
    await advance(30_000);
    expect(listingCalls()).toHaveLength(2);
  });

  it('aggiornamento senza sfarfallio: la sezione resta montata e i brani invariati restano gli stessi nodi', async () => {
    serve(versioned([item('a.mp3', 'Primo'), item('b.mp3', 'Secondo')]));
    render();
    await flush();
    const firstCard = container.querySelector('li');
    expect(firstCard?.textContent).toContain('Primo');

    // Nuova versione con un elenco lento: mentre arriva, la sezione resta visibile.
    let release: (listing: Listing) => void = () => undefined;
    server.version = V2;
    server.listing = () =>
      new Promise<Listing>((resolve) => {
        release = resolve;
      });
    await advance(30_000);
    expect(listingCalls()).toHaveLength(2);
    expect(container.textContent).toContain('Primo');
    expect(container.querySelector('li')).toBe(firstCard);

    await act(async () =>
      release({
        items: [item('a.mp3', 'Primo'), item('b.mp3', 'Secondo'), item('c.mp3', 'Terzo')],
        version: V2,
      }),
    );
    await flush();
    expect(container.textContent).toContain('Terzo');
    // Il brano che c'era è lo stesso elemento: niente rimontaggio (né salti di scorrimento).
    expect(container.querySelector('li')).toBe(firstCard);
  });

  it('l’aggiornamento non tocca il player: niente riproduzione o coda nuova', async () => {
    serve(versioned([item('a.mp3', 'Primo'), item('b.mp3', 'Secondo')]));
    render();
    await flush();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Riproduci Primo di Solco"]')
        ?.click(),
    );
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);

    server.version = V2;
    server.listing = versioned([item('b.mp3', 'Secondo')]);
    await advance(30_000);
    expect(container.textContent).not.toContain('Primo');
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
  });

  it('una richiesta bloccata si interrompe dopo ~10 s: gli aggiornamenti della scheda non si fermano', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    const normal = mocks.apiFetch.getMockImplementation();
    let stall = true;
    mocks.apiFetch.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
      if (stall && url === VERSION_URL) {
        stall = false;
        // Connessione bloccata: risponde solo se la richiesta viene interrotta.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Richiesta interrotta', 'AbortError')),
          );
        });
      }
      return normal?.(url, init);
    });
    render();
    await flush();
    expect(calls()).toEqual([VERSION_URL]);
    await advance(10_000);
    // Interrotta: riserva senza versione, la sezione compare.
    expect(calls()).toEqual([VERSION_URL, '/api/music/home-tracks']);
    expect(container.textContent).toContain('Primo');
    // E i controlli ripartono (riserva: dopo 2 minuti; la versione ora risponde).
    await advance(120_000);
    expect(versionCalls()).toHaveLength(2);
    await advance(30_000);
    expect(versionCalls()).toHaveLength(3);
    // Ogni richiesta porta il suo segnale di interruzione.
    for (const [, init] of mocks.apiFetch.mock.calls) {
      expect((init as { signal?: unknown })?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('mai indietro: una versione con listedAt più vecchio (istanza rimasta indietro) è ignorata', async () => {
    const OLD_AT = '2026-11-15T10:00:00.000Z';
    const NEW_AT = '2026-11-15T10:00:32.000Z';
    // La CDN rivalidata ora da un'istanza aggiornata, ora da una rimasta indietro.
    const answers = [
      { version: V1, listedAt: OLD_AT },
      { version: V2, listedAt: NEW_AT },
      { version: V1, listedAt: OLD_AT },
      { version: V2, listedAt: '2026-11-15T10:01:20.000Z' },
    ];
    const listings: Record<string, Listing> = {
      [V1]: { items: [item('a.mp3', 'Primo')], version: V1, listedAt: OLD_AT },
      [V2]: {
        items: [item('nuovo.mp3', 'Nuovo'), item('a.mp3', 'Primo')],
        version: V2,
        listedAt: NEW_AT,
      },
    };
    let poll = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === VERSION_URL) {
        const answer = answers[Math.min(poll, answers.length - 1)];
        poll += 1;
        return { ...answer, updatedAt: OLD_AT };
      }
      return listings[new URL(url, 'https://solco.test').searchParams.get('v') ?? V1];
    });
    render();
    await flush();
    const visible = [container.textContent?.includes('Nuovo')];
    for (let index = 0; index < 3; index += 1) {
      await advance(30_000);
      visible.push(container.textContent?.includes('Nuovo'));
    }
    expect(visible).toEqual([false, true, true, true]);
    expect(listingCalls()).toEqual([
      `/api/music/home-tracks?v=${V1}`,
      `/api/music/home-tracks?v=${V2}`,
    ]);
  });

  it('riserva senza versione: un elenco più vecchio di quello mostrato non lo sostituisce', async () => {
    const NEW_AT = '2026-11-15T10:00:32.000Z';
    serve((url) =>
      url.includes('?v=')
        ? { items: [item('nuovo.mp3', 'Nuovo')], version: V1, listedAt: NEW_AT }
        : { items: [item('a.mp3', 'Primo')], listedAt: '2026-11-15T09:59:00.000Z' },
    );
    render();
    await flush();
    expect(container.textContent).toContain('Nuovo');
    server.versionFails = true;
    await advance(30_000);
    expect(listingCalls()).toEqual([`/api/music/home-tracks?v=${V1}`, '/api/music/home-tracks']);
    expect(container.textContent).toContain('Nuovo');
    expect(container.textContent).not.toContain('Primo');
  });

  it('elenco vuoto e non definitivo (store non leggibile su un’istanza): i brani mostrati restano', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    render();
    await flush();
    server.version = V2;
    server.listing = () => ({ items: [] });
    await advance(30_000);
    expect(container.querySelector('section')).not.toBeNull();
    expect(container.textContent).toContain('Primo');
    // Al controllo successivo lo richiede: quella versione non risulta mostrata.
    server.listing = versioned([item('a.mp3', 'Primo'), item('b.mp3', 'Secondo')]);
    await advance(30_000);
    expect(listingCalls()).toEqual([
      `/api/music/home-tracks?v=${V1}`,
      `/api/music/home-tracks?v=${V2}`,
      `/api/music/home-tracks?v=${V2}`,
    ]);
    expect(container.textContent).toContain('Secondo');
  });

  it('tutti i brani tolti davvero (elenco vuoto CON versione): la sezione si nasconde', async () => {
    serve(versioned([item('a.mp3', 'Primo')]));
    render();
    await flush();
    server.version = V2;
    server.listing = versioned([]);
    await advance(30_000);
    expect(container.querySelector('section')).toBeNull();
  });

  it('errore al primo caricamento: sezione nascosta, poi compare al controllo successivo', async () => {
    let fail = true;
    serve((url) => {
      if (fail) throw new Error('apiFetch failed (500)');
      return versioned([item('a.mp3', 'Primo')])(url);
    });
    render();
    await flush();
    expect(container.querySelector('section')).toBeNull();
    fail = false;
    await advance(30_000);
    expect(container.textContent).toContain('Primo');
  });
});

describe('HomeTracksSection: sezioni e copertine', () => {
  it('una sezione per cartella, con copertina, artista e coda della sola sezione', async () => {
    const rock = [
      {
        ...item('Rock/Vasco - Uno.mp3', 'Uno'),
        artist: 'Vasco',
        artworkUrl: 'https://store.public.blob.vercel-storage.com/Rock/cover.jpg',
      },
      { ...item('Rock/Due.mp3', 'Due'), artworkUrl: null },
    ];
    const root = [{ ...item('radice.mp3', 'Radice'), artworkUrl: null }];
    serve({
      items: [...rock, ...root],
      sections: [
        { id: '', title: 'In evidenza', items: root },
        { id: 'Rock', title: 'Rock', items: rock },
      ],
    });
    render();
    await flush();
    const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual(['Ascolta ora', 'Rock']);
    expect(container.querySelector('#in-evidenza')).not.toBeNull();
    const cover = container.querySelector<HTMLImageElement>('img');
    expect(cover?.getAttribute('src')).toBe(
      'https://store.public.blob.vercel-storage.com/Rock/cover.jpg',
    );
    const play = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Uno di Vasco"]',
    );
    expect(play).not.toBeNull();
    act(() => play?.click());
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [track, , queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(track).toMatchObject({
      title: 'Uno',
      artistName: 'Vasco',
      artworkUrl: 'https://store.public.blob.vercel-storage.com/Rock/cover.jpg',
    });
    expect((queue as Array<{ title: string }>).map((entry) => entry.title)).toEqual(['Uno', 'Due']);
  });

  it('il nome dell’artista è un link alla sua pagina SOLO con artistSlug', async () => {
    const items = [
      { ...item('a.mp3', 'Caruso'), artist: 'Lucio Dalla', artistSlug: 'lucio-dalla' },
      { ...item('b.mp3', 'Hit'), artist: 'Artista Commerciale', artistSlug: null },
      { ...item('c.mp3', 'Vecchio'), artist: 'Server meno recente' },
      { ...item('d.mp3', 'Senza artista') },
    ];
    serve({
      items,
      sections: [{ id: '', title: 'In evidenza', items }],
    });
    render();
    await flush();
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Lucio Dalla', '/artista/lucio-dalla'],
    ]);
    // Il link sta fuori dal pulsante di riproduzione (niente link dentro un pulsante).
    expect(links[0]?.closest('button')).toBeNull();
    // Gli altri nomi restano testo DENTRO il pulsante: il tocco sul nome fa partire il brano.
    for (const name of ['Artista Commerciale', 'Server meno recente', 'Solco']) {
      const byline = [...container.querySelectorAll('span')].find(
        (span) => span.textContent === name,
      );
      expect(byline?.closest('button')).not.toBeNull();
    }
    const commercial = [...container.querySelectorAll('span')].find(
      (span) => span.textContent === 'Artista Commerciale',
    );
    act(() => commercial?.click());
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    mocks.playTrack.mockClear();
    // Il tocco sulla copertina suona ancora il brano.
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Riproduci Caruso di Lucio Dalla"]')
        ?.click(),
    );
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
  });

  it('risposta senza sezioni (server meno recente): una sola sezione "In evidenza"', async () => {
    serve({ items: [item('a.mp3', 'Primo')] });
    render();
    await flush();
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Ascolta ora',
    ]);
  });
});
