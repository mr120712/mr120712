// @polsia:user-owned — ricerca veloce della Home: il gruppo «Dalla tua Libreria». Solo chi ha fatto
// l'accesso fa la richiesta PRIVATA (/api/music/library/search), con lo stesso debounce e in
// parallelo ad Audius; una risposta vecchia viene ignorata (e la richiesta annullata), un errore
// nasconde solo quel gruppo, i gruppi restano a schermo finché non arriva la risposta nuova (le due
// risposte entrano insieme, la prima aspetta l'altra al massimo ANSWER_GRACE_MS). Le raccolte aprono
// la Libreria con il link diretto e i brani suonano con lo STESSO avvio della Libreria; tastiera
// (frecce, Invio, Esc, voce evidenziata seguita per id) e conteggi per i lettori di schermo coprono
// tutte le voci. Un prefisso già senza risultati nella Libreria non la richiede di nuovo.
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  push: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
  signedIn: true,
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/image', () => ({
  default: (props: { alt: string }) => <span data-testid="thumb">{props.alt}</span>,
}));
vi.mock('@/components/custom/music/music-player', () => ({
  useMusicPlayer: () => ({
    currentTrack: mocks.currentTrack,
    status: 'idle',
    playTrack: mocks.playTrack,
    togglePlayback: mocks.togglePlayback,
  }),
  trackStreamPath: (track: { qualifiedId: string }) => `/stream/${track.qualifiedId}`,
}));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: mocks.signedIn }),
}));

import { collectionQueue } from '@/components/custom/music/collection-tracks';
import {
  ANSWER_GRACE_MS,
  LiveMusicSearch,
  libraryKnownEmpty,
} from '@/components/custom/music/live-music-search';
import type { LibrarySearchResponse, LibrarySearchTrack } from '@/lib/contracts/library-search';
import { LibrarySearchResponseSchema } from '@/lib/contracts/library-search';

function audius(id: string, title: string) {
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title,
    artistName: `Artista ${title}`,
    artistUrl: `https://audius.co/artista-${id}`,
    trackUrl: `https://audius.co/artista-${id}/brano`,
    artworkUrl: `https://audius.co/art-${id}.jpg`,
    durationSeconds: 180,
    playbackEligible: true,
  };
}

function savedTrack(n: number, overrides: Partial<LibrarySearchTrack> = {}): LibrarySearchTrack {
  return {
    id: `item-${n}`,
    source: 'audius',
    sourceId: `trk-${n}`,
    title: `Notte salvata ${n}`,
    creatorName: `Autore ${n}`,
    artworkUrl: `https://audius.co/images/cover-${n}.jpg`,
    sourceUrl: `https://audius.co/autore/notte-${n}`,
    artistUrl: 'https://audius.co/autore',
    durationSeconds: 200,
    collectionId: 'pl-2',
    collectionName: 'Notte in città',
    collectionKind: 'playlist',
    otherCollectionCount: 0,
    ...overrides,
  };
}

const covers = [1, 2, 3, 4].map((index) => `https://audius.co/images/cover-${index}.jpg`);

/** 3 raccolte (il menù ne mostra 2) e 5 brani: uno senza attribuzione completa (non parte). */
const library: LibrarySearchResponse = {
  query: 'notte',
  collections: [
    {
      id: 'pl-2',
      name: 'Notte in città',
      kind: 'playlist',
      description: null,
      itemCount: 12,
      covers,
    },
    {
      id: 'fav-1',
      name: 'I miei cuori',
      kind: 'favorites',
      description: null,
      itemCount: 1,
      covers,
    },
    { id: 'pl-9', name: 'Notte terza', kind: 'playlist', description: null, itemCount: 3, covers },
  ],
  tracks: [
    savedTrack(1, { artistUrl: null, title: 'Notte incompleta' }),
    savedTrack(2),
    savedTrack(3, {
      collectionId: 'fav-1',
      collectionName: 'I miei cuori',
      collectionKind: 'favorites',
    }),
    savedTrack(4),
    savedTrack(5, { title: 'Notte quinta' }),
  ],
};

const audiusResponse = { tracks: [audius('a', 'Primo'), audius('b', 'Secondo')] };

type Handler = (url: string, init?: RequestInit) => unknown;

/** La risposta della Libreria passa dallo schema che chiede il client: fixture fedeli al contratto. */
function serve(handler: Handler) {
  mocks.apiFetch.mockImplementation(
    async (url: string, init?: RequestInit & { schema?: ZodType<unknown> }) => {
      const value = await handler(url, init);
      return url.startsWith('/api/music/library/search') && init?.schema
        ? init.schema.parse(value)
        : value;
    },
  );
}

function defaultHandler(url: string) {
  if (url.startsWith('/api/music/library/search')) return library;
  if (url.startsWith('/api/music/search')) return audiusResponse;
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const roots: Array<ReturnType<typeof createRoot>> = [];
let container: HTMLDivElement;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<LiveMusicSearch />));
  return { container, root };
}

function input() {
  return container.querySelector('input') as HTMLInputElement;
}

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input(), value);
  act(() => {
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(name: string) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

/** Lascia scadere l'attesa della seconda risposta: la prima entra a schermo da sola. */
async function passGrace() {
  await act(async () => {
    vi.advanceTimersByTime(ANSWER_GRACE_MS);
  });
  await settle();
}

/** Fa scattare il debounce (250 ms) e lascia risolvere le richieste. */
async function flush() {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await settle();
}

function libraryCalls() {
  return mocks.apiFetch.mock.calls.filter(([url]) =>
    String(url).startsWith('/api/music/library/search'),
  );
}

function audiusCalls() {
  return mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/music/search?'));
}

function options() {
  return [...container.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
}

function group(label: string) {
  return [...container.querySelectorAll<HTMLElement>('[role="group"]')].find((element) => {
    const labelId = element.getAttribute('aria-labelledby') ?? '';
    return document.getElementById(labelId)?.textContent === label;
  });
}

function status() {
  return container.querySelector('output')?.textContent ?? '';
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.currentTrack = null;
  mocks.signedIn = true;
  serve(defaultHandler);
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe('LiveMusicSearch: «Dalla tua Libreria»', () => {
  it('senza accesso nessuna richiesta alla Libreria e nessun gruppo', async () => {
    mocks.signedIn = false;
    render();
    type('notte');
    await flush();

    expect(libraryCalls()).toHaveLength(0);
    expect(audiusCalls().map(([url]) => url)).toEqual(['/api/music/search?source=audius&q=notte']);
    expect(container.textContent).not.toContain('Dalla tua Libreria');
    // Un solo gruppo: niente etichetta «Da Audius», i suggerimenti restano come prima.
    expect(container.textContent).not.toContain('Da Audius');
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);
  });

  it('con l’accesso le due richieste partono insieme dopo il debounce, la Libreria privata e mai in cache', async () => {
    const mine = deferred<unknown>();
    const audiusAnswer = deferred<unknown>();
    serve((url) =>
      url.startsWith('/api/music/library/search') ? mine.promise : audiusAnswer.promise,
    );
    render();
    type('notte');

    // Prima del debounce nessuna richiesta.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    // Entrambe in volo prima che una delle due risponda.
    expect(libraryCalls().map(([url]) => url)).toEqual(['/api/music/library/search?q=notte']);
    expect(audiusCalls().map(([url]) => url)).toEqual(['/api/music/search?source=audius&q=notte']);
    const [, libraryInit] = libraryCalls()[0] ?? [];
    expect(libraryInit.signal).toBeInstanceOf(AbortSignal);
    expect(libraryInit.cache).toBe('no-store');
    expect(libraryInit.schema).toBe(LibrarySearchResponseSchema);
    // L'URL pubblico e cacheabile di Audius non porta nulla della Libreria.
    expect(String(audiusCalls()[0]?.[0])).not.toContain('library');

    // La Libreria risponde prima: aspetta Audius per poco, poi il gruppo compare da solo.
    await act(async () => mine.resolve(library));
    await settle();
    expect(group('Dalla tua Libreria')).toBeUndefined();
    await passGrace();
    expect(group('Dalla tua Libreria')).toBeTruthy();
    expect(input().getAttribute('aria-expanded')).toBe('true');

    await act(async () => audiusAnswer.resolve(audiusResponse));
    await settle();
    expect(group('Da Audius')).toBeTruthy();
  });

  it('mostra al massimo 2 raccolte e 3 brani che possono partire, sopra i suggerimenti Audius', async () => {
    render();
    type('notte');
    await flush();

    const libraryGroup = group('Dalla tua Libreria') as HTMLElement;
    const audiusGroup = group('Da Audius') as HTMLElement;
    expect(libraryGroup).toBeTruthy();
    expect(audiusGroup).toBeTruthy();
    // Il gruppo della Libreria viene prima di quello di Audius nel menù.
    expect(
      libraryGroup.compareDocumentPosition(audiusGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const collections = libraryGroup.querySelectorAll<HTMLElement>('[data-kind="collection"]');
    expect([...collections].map((option) => option.textContent)).toEqual([
      'Notte in cittàPlaylist · 12 brani',
      'I miei cuoriPreferiti · 1 brano',
    ]);
    // Copertina a mosaico della Libreria (4 copertine diverse → griglia 2×2).
    expect(collections[0]?.querySelector('[data-layout="grid"]')).toBeTruthy();
    expect(container.textContent).not.toContain('Notte terza');

    const tracks = libraryGroup.querySelectorAll<HTMLElement>('[data-kind="library-track"]');
    expect([...tracks].map((option) => option.textContent)).toEqual([
      'Notte salvata 2Autore 2 · in Notte in città',
      'Notte salvata 3Autore 3 · in I miei cuori',
      'Notte salvata 4Autore 4 · in Notte in città',
    ]);
    // Il brano senza attribuzione completa non diventa una voce che non fa nulla.
    expect(container.textContent).not.toContain('Notte incompleta');
    expect(container.textContent).not.toContain('Notte quinta');

    expect(audiusGroup.querySelectorAll('[data-kind="audius"]')).toHaveLength(2);
    expect(status()).toBe(
      '5 risultati dalla tua Libreria e 2 brani da Audius. Usa le frecce su e giù per sceglierne uno.',
    );
    // «Vedi tutti» resta in fondo e porta alla ricerca completa (con la sezione della Libreria).
    const seeAll = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Vedi tutti'),
    ) as HTMLButtonElement;
    act(() => {
      seeAll.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(mocks.push).toHaveBeenCalledWith('/search?q=notte');
  });

  it('una raccolta apre la Libreria con il link diretto, un brano suona come nella Libreria', async () => {
    render();
    type('notte');
    await flush();

    const collection = container.querySelector('[data-kind="collection"]') as HTMLElement;
    act(() => {
      collection.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(mocks.push).toHaveBeenCalledWith('/library?playlist=pl-2');
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    // Riapre il menù e sceglie il secondo brano salvato.
    act(() => {
      input().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    const track = container.querySelectorAll<HTMLElement>('[data-kind="library-track"]')[1];
    expect(track).toBeTruthy();
    act(() => {
      track?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [played, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(played.qualifiedId).toBe('audius:trk-3');
    expect(path).toBe('/stream/audius:trk-3');
    // Stessa conversione e stessa coda della Libreria: i brani mostrati, nell'ordine mostrato.
    expect(queue).toEqual(collectionQueue(library.tracks.slice(1, 4)));
  });

  it('sul brano già in riproduzione mette in pausa o riprende, come nella Libreria', async () => {
    mocks.currentTrack = { qualifiedId: 'audius:trk-2' };
    render();
    type('notte');
    await flush();

    const track = container.querySelector('[data-kind="library-track"]') as HTMLElement;
    act(() => {
      track.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(mocks.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('ignora le risposte vecchie, annulla la richiesta precedente e non fa sfarfallare i gruppi', async () => {
    const rounds = new Map(
      ['notte', 'notturno', 'notturna'].map((term) => [
        term,
        { mine: deferred<unknown>(), audius: deferred<unknown>() },
      ]),
    );
    serve((url) => {
      const term = new URL(url, 'https://solco.test').searchParams.get('q') ?? '';
      const round = rounds.get(term);
      if (!round) throw new Error(`ricerca inattesa: ${term}`);
      return url.startsWith('/api/music/library/search')
        ? round.mine.promise
        : round.audius.promise;
    });
    const round = (term: string) => rounds.get(term) as NonNullable<ReturnType<typeof rounds.get>>;
    render();

    // Prima ricerca: arriva solo la Libreria (Audius resta in volo).
    type('notte');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => round('notte').mine.resolve(library));
    await passGrace();
    expect(group('Dalla tua Libreria')).toBeTruthy();

    // Seconda ricerca: finché la risposta nuova non arriva, il gruppo già a schermo resta.
    type('notturno');
    expect(group('Dalla tua Libreria')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(group('Dalla tua Libreria')).toBeTruthy();
    expect(container.textContent).toContain('Notte in città');

    // Terza ricerca mentre la seconda è ancora in volo: la richiesta privata precedente è annullata.
    type('notturna');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(libraryCalls().map(([url]) => url)).toEqual([
      '/api/music/library/search?q=notte',
      '/api/music/library/search?q=notturno',
      '/api/music/library/search?q=notturna',
    ]);
    const signals = libraryCalls().map(([, init]) => init.signal as AbortSignal);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, true, false]);
    expect(group('Dalla tua Libreria')).toBeTruthy();
    // Spinner acceso finché le richieste della ricerca attuale sono in volo.
    expect(container.querySelector('.lucide-search')).toBeNull();

    // La risposta nuova sostituisce i gruppi…
    const fresh: LibrarySearchResponse = {
      query: 'notturna',
      collections: [
        {
          id: 'pl-7',
          name: 'Notturna',
          kind: 'playlist',
          description: null,
          itemCount: 2,
          covers: [],
        },
      ],
      tracks: [],
    };
    await act(async () => round('notturna').mine.resolve(fresh));
    await act(async () =>
      round('notturna').audius.resolve({ tracks: [audius('n', 'Notturno op. 9')] }),
    );
    await settle();
    // …e quelle vecchie, arrivate dopo, vengono ignorate.
    await act(async () => round('notte').audius.resolve(audiusResponse));
    await act(async () => round('notturno').mine.resolve(library));
    await act(async () => round('notturno').audius.resolve(audiusResponse));
    await settle();

    expect(options().map((option) => option.textContent)).toEqual([
      'NNotturnaPlaylist · 2 brani',
      'Notturno op. 9Artista Notturno op. 9',
    ]);
    expect(container.textContent).not.toContain('Primo');
    expect(container.textContent).not.toContain('Notte in città');
    // Tutte le risposte sono arrivate: niente spinner rimasto acceso.
    expect(container.querySelector('.lucide-search')).toBeTruthy();
  });

  it('un errore della Libreria (401/429) nasconde solo il suo gruppo: Audius resta', async () => {
    serve((url) => {
      if (url.startsWith('/api/music/library/search')) {
        throw new Error('apiFetch /api/music/library/search failed (429)');
      }
      return audiusResponse;
    });
    render();
    type('notte');
    await flush();

    expect(libraryCalls()).toHaveLength(1);
    expect(container.textContent).not.toContain('Dalla tua Libreria');
    expect(container.textContent).not.toContain('Da Audius');
    expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);
    expect(status()).toBe('2 brani da Audius. Usa le frecce su e giù per sceglierne uno.');
  });

  it('un errore dopo una risposta riuscita toglie il gruppo vecchio', async () => {
    let failLibrary = false;
    serve((url) => {
      if (url.startsWith('/api/music/library/search')) {
        if (failLibrary) throw new Error('apiFetch /api/music/library/search failed (401)');
        return library;
      }
      return audiusResponse;
    });
    render();
    type('notte');
    await flush();
    expect(group('Dalla tua Libreria')).toBeTruthy();

    failLibrary = true;
    type('notti');
    await flush();
    expect(group('Dalla tua Libreria')).toBeUndefined();
    expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);
  });

  it('le frecce percorrono Libreria e Audius nell’ordine visivo (aria-activedescendant)', async () => {
    render();
    type('notte');
    await flush();

    const ids = options().map((option) => option.id);
    expect(options().map((option) => option.dataset.kind)).toEqual([
      'collection',
      'collection',
      'library-track',
      'library-track',
      'library-track',
      'audius',
      'audius',
    ]);
    // Il combobox controlla il listbox; le voci non entrano nel giro del Tab.
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(input().getAttribute('aria-controls')).toBe(listbox.id);
    expect(options().every((option) => option.tabIndex === -1)).toBe(true);

    const visited: string[] = [];
    for (let step = 0; step < ids.length; step += 1) {
      key('ArrowDown');
      visited.push(input().getAttribute('aria-activedescendant') ?? '');
    }
    expect(visited).toEqual(ids);
    const selected = options().filter((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected.map((option) => option.id)).toEqual([ids[ids.length - 1]]);

    // Dall'ultima voce si torna alla prima, e con la freccia su di nuovo all'ultima.
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(ids[0]);
    key('ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe(ids[ids.length - 1]);
  });

  it('da tastiera la voce evidenziata scorre in vista, col mouse no', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      render();
      type('notte');
      await flush();

      const audiusOption = options().at(-1) as HTMLElement;
      act(() => {
        audiusOption.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(input().getAttribute('aria-activedescendant')).toBe(audiusOption.id);
      expect(scrollIntoView).not.toHaveBeenCalled();

      key('ArrowDown');
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(options()[0]);
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('Invio su una raccolta apre la Libreria', async () => {
    render();
    type('notte');
    await flush();

    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(mocks.push).toHaveBeenCalledWith('/library?playlist=fav-1');
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('Invio su un brano salvato lo riproduce dalla Libreria', async () => {
    render();
    type('notte');
    await flush();

    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [played, path] = mocks.playTrack.mock.calls[0] ?? [];
    expect(played.qualifiedId).toBe('audius:trk-2');
    expect(path).toBe('/stream/audius:trk-2');
  });

  it('Invio su un suggerimento Audius lo riproduce come prima', async () => {
    render();
    type('notte');
    await flush();

    for (let step = 0; step < 6; step += 1) key('ArrowDown');
    key('Enter');
    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [played, path] = mocks.playTrack.mock.calls[0] ?? [];
    expect(played.qualifiedId).toBe('audius:a');
    expect(path).toBe('/api/music/audius/tracks/a/stream');
  });

  it('Invio senza voce evidenziata apre la ricerca completa', async () => {
    render();
    type('notte');
    await flush();

    const form = container.querySelector('form') as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mocks.push).toHaveBeenCalledWith('/search?q=notte');
  });

  it('Esc chiude il menù', async () => {
    render();
    type('notte');
    await flush();
    key('ArrowDown');
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();

    key('Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('svuotando il campo il gruppo sparisce e una risposta in volo viene annullata', async () => {
    const mine = deferred<unknown>();
    serve((url) => (url.startsWith('/api/music/library/search') ? mine.promise : audiusResponse));
    render();
    type('notte');
    await flush();

    type('n');
    const [, init] = libraryCalls()[0] ?? [];
    expect((init.signal as AbortSignal).aborted).toBe(true);
    await act(async () => mine.resolve(library));
    await settle();
    expect(container.textContent).not.toContain('Dalla tua Libreria');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('uscendo dall’account il gruppo della Libreria sparisce', async () => {
    const { root } = render();
    type('notte');
    await flush();
    expect(group('Dalla tua Libreria')).toBeTruthy();

    mocks.signedIn = false;
    act(() => root.render(<LiveMusicSearch />));
    expect(group('Dalla tua Libreria')).toBeUndefined();
    expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);

    // E le ricerche successive non chiedono più la Libreria.
    type('notti');
    await flush();
    expect(libraryCalls()).toHaveLength(1);
  });

  describe('la voce evidenziata resta quella scelta quando arriva l’altra risposta', () => {
    const emptyLibrary: LibrarySearchResponse = { query: 'notte', collections: [], tracks: [] };

    function twoAnswers() {
      const mine = deferred<unknown>();
      const audiusAnswer = deferred<unknown>();
      serve((url) =>
        url.startsWith('/api/music/library/search') ? mine.promise : audiusAnswer.promise,
      );
      return { mine, audiusAnswer };
    }

    it.each([
      ['vuota (nulla cambia a schermo)', emptyLibrary],
      ['con risultati (il gruppo compare sopra)', library],
    ])(
      'Audius prima, poi la Libreria %s: Invio riproduce il suggerimento evidenziato',
      async (_, mineValue) => {
        const { mine, audiusAnswer } = twoAnswers();
        render();
        type('notte');
        await act(async () => {
          vi.advanceTimersByTime(300);
        });
        await act(async () => audiusAnswer.resolve(audiusResponse));
        await settle();
        // Audius aspetta la Libreria per poco: nessuna voce finché l'attesa non scade.
        expect(options()).toHaveLength(0);
        await passGrace();
        expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);

        key('ArrowDown');
        const highlighted = input().getAttribute('aria-activedescendant') ?? '';
        expect(highlighted).toMatch(/-opt-a$/);

        await act(async () => mine.resolve(mineValue));
        await settle();
        expect(input().getAttribute('aria-activedescendant')).toBe(highlighted);
        const selected = options().filter(
          (option) => option.getAttribute('aria-selected') === 'true',
        );
        expect(selected.map((option) => option.id)).toEqual([highlighted]);

        key('Enter');
        expect(mocks.push).not.toHaveBeenCalled();
        expect(mocks.playTrack).toHaveBeenCalledTimes(1);
        expect(mocks.playTrack.mock.calls[0]?.[0].qualifiedId).toBe('audius:a');
      },
    );

    it('Libreria prima, poi Audius senza brani: Invio apre la raccolta evidenziata', async () => {
      const { mine, audiusAnswer } = twoAnswers();
      render();
      type('notte');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      await act(async () => mine.resolve(library));
      await passGrace();

      key('ArrowDown');
      const highlighted = input().getAttribute('aria-activedescendant') ?? '';
      expect(highlighted).toMatch(/-col-pl-2$/);

      await act(async () => audiusAnswer.resolve({ tracks: [] }));
      await settle();
      expect(input().getAttribute('aria-activedescendant')).toBe(highlighted);

      key('Enter');
      expect(mocks.push).toHaveBeenCalledTimes(1);
      expect(mocks.push).toHaveBeenCalledWith('/library?playlist=pl-2');
      expect(mocks.playTrack).not.toHaveBeenCalled();
    });

    it('una voce che sparisce con la risposta nuova non resta evidenziata', async () => {
      render();
      type('notte');
      await flush();
      // Evidenzia una voce della ricerca precedente, poi la risposta nuova non la contiene più.
      serve((url) =>
        url.startsWith('/api/music/library/search')
          ? emptyLibrary
          : { tracks: [audius('n', 'Notturno')] },
      );
      type('notturno');
      key('ArrowDown');
      expect(input().getAttribute('aria-activedescendant')).toMatch(/-col-pl-2$/);
      await flush();
      expect(input().hasAttribute('aria-activedescendant')).toBe(false);
      key('Enter');
      expect(mocks.push).not.toHaveBeenCalled();
      expect(mocks.playTrack).not.toHaveBeenCalled();
    });
  });

  it('le due risposte entrano insieme: il menù non cambia a metà fra i gruppi', async () => {
    render();
    type('notte');
    await flush();
    const before = options().map((option) => option.textContent);
    expect(before).toHaveLength(7);

    const mine = deferred<unknown>();
    const audiusAnswer = deferred<unknown>();
    serve((url) =>
      url.startsWith('/api/music/library/search') ? mine.promise : audiusAnswer.promise,
    );
    type('notturno');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // Audius risponde per primo: finché la Libreria non risponde, il menù resta quello di prima.
    await act(async () => audiusAnswer.resolve({ tracks: [audius('n', 'Notturno op. 9')] }));
    await settle();
    expect(options().map((option) => option.textContent)).toEqual(before);

    await act(async () =>
      mine.resolve({
        query: 'notturno',
        collections: [
          {
            id: 'pl-7',
            name: 'Notturno',
            kind: 'playlist',
            description: null,
            itemCount: 2,
            covers,
          },
        ],
        tracks: [],
      }),
    );
    await settle();
    expect(options().map((option) => option.textContent)).toEqual([
      'NotturnoPlaylist · 2 brani',
      'Notturno op. 9Artista Notturno op. 9',
    ]);
    // L'attesa scaduta più tardi non cambia più nulla.
    await passGrace();
    expect(options()).toHaveLength(2);
  });

  it('uscendo dall’account la voce evidenziata non scivola su un suggerimento Audius', async () => {
    const { root } = render();
    type('notte');
    await flush();
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toMatch(/-col-pl-2$/);

    mocks.signedIn = false;
    act(() => root.render(<LiveMusicSearch />));
    expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
    key('Enter');
    expect(mocks.playTrack).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();

    // Le frecce ripartono dalla prima voce rimasta.
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toMatch(/-opt-a$/);
  });

  describe('un prefisso già senza risultati non richiede di nuovo la Libreria', () => {
    it('libraryKnownEmpty: solo estensioni di un termine vuoto, mai con il separatore', () => {
      expect(libraryKnownEmpty('notturno', 'nott')).toBe(true);
      expect(libraryKnownEmpty('nott', 'nott')).toBe(true);
      expect(libraryKnownEmpty('not', 'nott')).toBe(false);
      expect(libraryKnownEmpty('nott', null)).toBe(false);
      // «Artista - Titolo» si confronta anche senza separatore: «artista -» vuoto non dice nulla.
      expect(libraryKnownEmpty('artista - titolo', 'artista -')).toBe(false);
      expect(libraryKnownEmpty('artista – titolo', 'artista –')).toBe(false);
    });

    it('niente richiesta per le estensioni, di nuovo per un termine diverso o dopo aver svuotato', async () => {
      serve((url) => {
        if (url.startsWith('/api/music/library/search')) {
          const q = new URL(url, 'https://solco.test').searchParams.get('q') ?? '';
          return q === 'xy' ? library : { query: q, collections: [], tracks: [] };
        }
        return audiusResponse;
      });
      const libraryTerms = () =>
        libraryCalls().map(([url]) =>
          new URL(String(url), 'https://solco.test').searchParams.get('q'),
        );
      render();

      type('xyz');
      await flush();
      expect(libraryTerms()).toEqual(['xyz']);

      // «xyzw» contiene «xyz»: la Libreria non può avere risultati, Audius sì.
      type('xyzw');
      await flush();
      expect(libraryTerms()).toEqual(['xyz']);
      expect(audiusCalls()).toHaveLength(2);
      expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);

      // Un termine che non è un'estensione si richiede (e qui ha risultati).
      type('xy');
      await flush();
      expect(libraryTerms()).toEqual(['xyz', 'xy']);
      expect(group('Dalla tua Libreria')).toBeTruthy();

      // Di nuovo un'estensione di «xyz»: niente richiesta e il gruppo di «xy» sparisce.
      type('xyzw');
      await flush();
      expect(libraryTerms()).toEqual(['xyz', 'xy']);
      expect(group('Dalla tua Libreria')).toBeUndefined();
      expect(options().map((option) => option.dataset.kind)).toEqual(['audius', 'audius']);

      // Svuotando il campo si ricomincia da capo.
      type('x');
      type('xyzw');
      await flush();
      expect(libraryTerms()).toEqual(['xyz', 'xy', 'xyzw']);
    });

    it('un prefisso con risultati o con errore non salta la richiesta', async () => {
      let fail = true;
      serve((url) => {
        if (url.startsWith('/api/music/library/search')) {
          if (fail) throw new Error('apiFetch /api/music/library/search failed (429)');
          return library;
        }
        return audiusResponse;
      });
      render();
      type('notte');
      await flush();
      fail = false;
      type('notte c');
      await flush();
      type('notte ci');
      await flush();
      expect(libraryCalls()).toHaveLength(3);
      expect(group('Dalla tua Libreria')).toBeTruthy();
    });
  });
});
