// @polsia:user-owned — «Le tue playlist» nella pagina Cerca (client): la sezione compare SOLO a chi
// ha fatto l'accesso, la richiesta privata parte in parallelo a search-all e viene annullata a ogni
// query nuova, un errore la nasconde in silenzio, il chip «Le tue» e «Tutto» restano coerenti, le
// raccolte aprono la Libreria con il link diretto e i brani suonano con lo STESSO avvio della
// Libreria (stesso brano del player, stesso percorso). Poi il link diretto nella Libreria
// (/library?playlist=<id>): porta alla raccolta, la mette in risalto e le dà il focus.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  playTrack: vi.fn(),
  togglePlayback: vi.fn(),
  replace: vi.fn(),
  toastError: vi.fn(),
  currentTrack: null as { qualifiedId: string } | null,
  signedIn: true,
  searchParams: new URLSearchParams(),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams,
}));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub forwards whatever the component passes.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({ default: (props: { alt: string }) => <span>{props.alt}</span> }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: mocks.toastError }),
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
  useLibrary: () => ({
    signedIn: mocks.signedIn,
    loading: false,
    library: { stations: [], podcasts: [], folders: [], history: [], hidden: [] },
    refresh: async () => undefined,
    mutate: async () => true,
    isHidden: () => false,
    isStationSaved: () => false,
    isPodcastFollowed: () => false,
  }),
}));
vi.mock('@/lib/auth-client', () => ({
  authClient: {},
  useSession: () => ({
    data: {
      user: { id: 'account-a', name: 'Ada Rossi', email: 'ada@example.test', emailVerified: true },
    },
  }),
}));
vi.mock('@/components/custom/music/fallback-art', () => ({
  FallbackArt: ({ src }: { src: string | null }) => <span data-art={src ?? ''} />,
}));
vi.mock('@/components/custom/music/ai-music-search', () => ({ AiMusicSearch: () => null }));
vi.mock('@/components/custom/music/listen-in-solco', () => ({ ListenInSolco: () => null }));
vi.mock('@/components/custom/music/offline-download-button', () => ({
  OfflineDownloadButton: () => null,
}));
// Solo per montare la Libreria: le altre parti della pagina non sono sotto test qui.
vi.mock('@/components/custom/music/local-music-section', () => ({ LocalMusicSection: () => null }));
vi.mock('@/components/custom/music/spotify-import', () => ({ SpotifyImport: () => null }));
vi.mock('@/components/custom/music/youtube-account-import', () => ({
  YouTubeAccountImport: () => null,
}));
vi.mock('@/components/custom/music/track-list-import', () => ({ TrackListImport: () => null }));
vi.mock('@/components/custom/music/ai-organize', () => ({ AiOrganize: () => null }));
vi.mock('@/components/custom/music/recently-played-row', () => ({
  useHistoryPlayback: () => ({ isPlaying: () => false, play: () => undefined }),
}));

import {
  collectionItemToTrack,
  collectionQueue,
} from '@/components/custom/music/collection-tracks';
import { LibraryView } from '@/components/custom/music/library-view';
import { MusicCollections } from '@/components/custom/music/music-collections';
import { UnifiedSearchResults } from '@/components/custom/music/unified-search-results';
import type { LibrarySearchResponse } from '@/lib/contracts/library-search';
import { LIBRARY_PLAYLIST_PARAM, libraryPlaylistPath } from '@/lib/music/library-links';

const station = {
  id: 'radio1',
  name: 'Radio Notte',
  artworkUrl: null,
  country: 'Italia',
  countryCode: 'IT',
  tags: ['jazz'],
  codec: null,
  bitrate: null,
  homepage: null,
  votes: 0,
};

const searchAll = {
  query: 'notte',
  youtubeRequested: false,
  results: [{ kind: 'radio', key: 'radio:radio1', score: 70, station }],
  sources: {
    audius: { status: 'empty', tracks: [], artists: [], playlists: [], albums: [] },
    youtube: { status: 'skipped', videos: [] },
    radio: { status: 'results', stations: [station] },
    podcasts: { status: 'empty', podcasts: [] },
  },
};

const covers = [1, 2, 3, 4].map((index) => `https://audius.co/images/cover-${index}.jpg`);
const audiusItem = {
  id: 'item-1',
  source: 'audius' as const,
  sourceId: 'trk-1',
  title: 'Notte stellata',
  creatorName: 'Artista Audius',
  artworkUrl: 'https://audius.co/images/cover-1.jpg',
  sourceUrl: 'https://audius.co/artista/notte-stellata',
  artistUrl: 'https://audius.co/artista',
  durationSeconds: 180,
};
const youtubeItem = {
  id: 'item-2',
  source: 'youtube' as const,
  sourceId: 'dQw4w9WgXcQ',
  title: 'Notte video',
  creatorName: 'Canale',
  artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
  sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  artistUrl: null,
  durationSeconds: null,
};

const library: LibrarySearchResponse = {
  query: 'notte',
  collections: [
    {
      id: 'pl-2',
      name: 'Notte in città',
      kind: 'playlist',
      description: 'Brani per tornare a casa tardi.',
      itemCount: 12,
      covers,
    },
    {
      id: 'fav-1',
      name: 'Preferiti',
      kind: 'favorites',
      description: null,
      itemCount: 1,
      covers: [],
    },
  ],
  tracks: [
    {
      ...audiusItem,
      collectionId: 'pl-2',
      collectionName: 'Notte in città',
      collectionKind: 'playlist',
      otherCollectionCount: 1,
    },
    {
      ...youtubeItem,
      collectionId: 'fav-1',
      collectionName: 'Preferiti',
      collectionKind: 'favorites',
      otherCollectionCount: 0,
    },
  ],
};

const emptyLibrary: LibrarySearchResponse = { query: 'mozart', collections: [], tracks: [] };

/** Le raccolte della Libreria (GET /api/music/collections) con lo stesso brano salvato. */
const libraryCollections = {
  collections: [
    {
      id: 'fav-1',
      name: 'Preferiti',
      kind: 'favorites',
      createdAt: '2026-11-01T00:00:00.000Z',
      items: [{ ...youtubeItem, createdAt: '2026-11-02T00:00:00.000Z', expiresAt: null }],
    },
    {
      id: 'pl-1',
      name: 'Primo',
      kind: 'playlist',
      createdAt: '2026-11-01T00:00:00.000Z',
      items: [],
    },
    {
      id: 'pl-2',
      name: 'Notte in città',
      kind: 'playlist',
      createdAt: '2026-11-03T00:00:00.000Z',
      items: [{ ...audiusItem, createdAt: '2026-11-04T00:00:00.000Z', expiresAt: null }],
    },
  ],
};

type Handler = (url: string, init?: RequestInit) => unknown;

/** Ogni risposta passa dallo schema che il client chiede: le fixture rispettano i contratti. */
function serve(handler: Handler) {
  mocks.apiFetch.mockImplementation(
    async (url: string, init?: RequestInit & { schema?: ZodType<unknown> }) => {
      const value = await handler(url, init);
      return init?.schema ? init.schema.parse(value) : value;
    },
  );
}

function defaultHandler(url: string) {
  if (url.startsWith('/api/music/search-all')) return searchAll;
  if (url.startsWith('/api/music/library/search')) return library;
  if (url === '/api/music/collections') return libraryCollections;
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  await flush();
  return { container, root };
}

function urlCalls() {
  return mocks.apiFetch.mock.calls.map((call) => String(call[0]));
}

function librarySection(container: HTMLElement) {
  return container.querySelector<HTMLElement>('section[data-section="library"]');
}

function chip(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('fieldset button')].find((b) =>
    b.textContent?.startsWith(label),
  );
}

function mixedRows(container: HTMLElement) {
  return [...container.querySelectorAll('ol li')].filter(
    (row) => row.getAttribute('data-kind') !== 'library',
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.playTrack.mockReset();
  mocks.togglePlayback.mockReset();
  mocks.replace.mockReset();
  mocks.toastError.mockReset();
  mocks.currentTrack = null;
  mocks.signedIn = true;
  mocks.searchParams = new URLSearchParams();
  serve(defaultHandler);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Cerca: «Le tue playlist» solo per chi ha fatto l’accesso', () => {
  it('senza accesso nessuna richiesta alla Libreria, nessuna sezione e nessun chip «Le tue»', async () => {
    mocks.signedIn = false;
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);

    expect(urlCalls().some((url) => url.startsWith('/api/music/library/search'))).toBe(false);
    expect(librarySection(container)).toBeNull();
    expect(chip(container, 'Le tue')).toBeUndefined();
    expect(container.textContent).not.toContain('Le tue playlist');
    expect(container.textContent).toContain('Radio Notte');
  });

  it('con l’accesso le due richieste partono insieme e la sezione non aspetta search-all', async () => {
    const all = deferred<unknown>();
    const mine = deferred<unknown>();
    serve((url) => (url.startsWith('/api/music/search-all') ? all.promise : mine.promise));
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);

    // Entrambe in volo prima che una delle due risponda.
    const calls = urlCalls();
    expect(calls.filter((url) => url.startsWith('/api/music/search-all'))).toHaveLength(1);
    expect(calls.filter((url) => url.startsWith('/api/music/library/search'))).toEqual([
      '/api/music/library/search?q=notte',
    ]);

    // La Libreria risponde prima: la sezione compare mentre le altre fonti cercano ancora.
    await act(async () => mine.resolve(library));
    await flush();
    expect(librarySection(container)).not.toBeNull();
    expect(container.textContent).toContain('Cerco “notte”…');

    await act(async () => all.resolve(searchAll));
    await flush();
    // In cima: la sezione precede l'elenco misto.
    const section = librarySection(container);
    const firstMixed = mixedRows(container)[0];
    expect(section && firstMixed).toBeTruthy();
    expect(
      (section as HTMLElement).compareDocumentPosition(firstMixed as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('una query nuova annulla la richiesta in volo e una risposta vecchia non compare', async () => {
    const first = deferred<unknown>();
    serve((url) => {
      if (url.startsWith('/api/music/search-all')) return { ...searchAll, query: 'x' };
      return url.includes('q=notte') ? first.promise : emptyLibrary;
    });
    const { container, root } = await render(<UnifiedSearchResults initialQuery="notte" />);
    const libraryCall = mocks.apiFetch.mock.calls.find((call) =>
      String(call[0]).startsWith('/api/music/library/search'),
    );
    const signal = (libraryCall?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal?.aborted).toBe(false);

    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(urlCalls()).toContain('/api/music/library/search?q=mozart');

    // La risposta della query vecchia arriva tardi: ignorata.
    await act(async () => first.resolve(library));
    await flush();
    expect(librarySection(container)).toBeNull();
    expect(container.textContent).not.toContain('Notte in città');
  });

  it('la risposta della query vecchia, già arrivata, sparisce (anche dai conteggi) mentre la nuova è in volo', async () => {
    const mozartLibrary = deferred<unknown>();
    const mozartAll = {
      ...searchAll,
      query: 'mozart',
      results: [
        {
          kind: 'radio',
          key: 'radio:radio2',
          score: 70,
          station: { ...station, id: 'radio2', name: 'Radio Mozart' },
        },
      ],
    };
    serve((url) => {
      if (url.startsWith('/api/music/search-all')) {
        return url.includes('q=mozart') ? mozartAll : searchAll;
      }
      return url.includes('q=mozart') ? mozartLibrary.promise : library;
    });
    const { container, root } = await render(<UnifiedSearchResults initialQuery="notte" />);
    expect(librarySection(container)).not.toBeNull();
    expect(chip(container, 'Tutto')?.textContent).toBe('Tutto 5');

    // search-all risponde subito (cache del browser/CDN), la Libreria no.
    await act(async () => root.render(<UnifiedSearchResults initialQuery="mozart" />));
    await flush();
    expect(container.textContent).toContain('Radio Mozart');
    expect(librarySection(container)).toBeNull();
    expect(container.textContent).not.toContain('Notte in città');
    expect(container.textContent).not.toContain('Notte stellata');
    expect(chip(container, 'Le tue')).toBeUndefined();
    expect(chip(container, 'Tutto')?.textContent).toBe('Tutto 1');
    expect(container.textContent).toContain('1 risultato');
    expect(container.querySelector('output')?.textContent).toBe('1 risultato per “mozart”.');

    // Arriva la risposta della query attuale: la sezione torna, con i suoi risultati.
    await act(async () =>
      mozartLibrary.resolve({
        query: 'mozart',
        collections: [{ ...library.collections[0], id: 'pl-9', name: 'Mozart e basta' }],
        tracks: [],
      }),
    );
    await flush();
    expect(librarySection(container)?.textContent).toContain('Mozart e basta');
    expect(chip(container, 'Tutto')?.textContent).toBe('Tutto 2');
  });

  it('un errore della Libreria nasconde la sezione in silenzio; le altre fonti restano', async () => {
    serve((url) => {
      if (url.startsWith('/api/music/library/search')) {
        throw new Error('apiFetch failed (429)', { cause: { error: 'rate_limited' } });
      }
      return defaultHandler(url);
    });
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);

    expect(librarySection(container)).toBeNull();
    expect(chip(container, 'Le tue')).toBeUndefined();
    expect(container.textContent).toContain('Radio Notte');
    expect(container.textContent).not.toContain('Troppe ricerche');
    expect(container.textContent).not.toContain('non è riuscita');
  });

  it('nessuna corrispondenza nella Libreria: nessuna sezione e conteggi invariati', async () => {
    serve((url) =>
      url.startsWith('/api/music/library/search')
        ? { ...emptyLibrary, query: 'notte' }
        : defaultHandler(url),
    );
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    expect(librarySection(container)).toBeNull();
    expect(chip(container, 'Tutto')?.textContent).toBe('Tutto 1');
  });
});

describe('Cerca: contenuto della sezione «Le tue playlist»', () => {
  it('schede delle raccolte: mosaico, nome come link diretto alla Libreria, badge, brani, descrizione', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    const section = librarySection(container);
    expect(section?.querySelector('h3')?.textContent).toBe('Le tue playlist');
    expect(section?.textContent).toContain('solo tu vedi questi risultati');

    const cards = [...(section?.querySelectorAll<HTMLElement>('ul > li') ?? [])];
    expect(cards).toHaveLength(2);
    const [playlist, favorites] = cards;

    const link = playlist?.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe('/library?playlist=pl-2');
    expect(link?.getAttribute('href')).toBe(libraryPlaylistPath('pl-2'));
    expect(link?.textContent).toContain('Notte in città');
    expect(playlist?.querySelector('[data-source="mine"]')?.textContent).toBe('La tua playlist');
    expect(playlist?.textContent).toContain('12 brani');
    expect(playlist?.textContent).toContain('Brani per tornare a casa tardi.');
    // Mosaico 2×2 con le copertine della raccolta (decorativo).
    expect(
      [...(playlist?.querySelectorAll('img') ?? [])].map((img) => img.getAttribute('src')),
    ).toEqual(covers);

    expect(favorites?.querySelector('a')?.getAttribute('href')).toBe('/library?playlist=fav-1');
    expect(favorites?.querySelector('[data-source="favorites"]')?.textContent).toBe('Preferiti');
    expect(favorites?.textContent).toContain('1 brano');
    // Nessuna copertina: l'iniziale del nome, come nella Libreria.
    expect(favorites?.querySelector('[data-layout="fallback"]')?.textContent).toBe('P');
  });

  it('righe «Nei tuoi brani»: titolo, artista, «in <playlist>» con link e le altre raccolte', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    const section = librarySection(container);
    expect(section?.querySelector('h4')?.textContent).toBe('Nei tuoi brani');
    const rows = [...(section?.querySelectorAll<HTMLElement>('li[data-kind="library"]') ?? [])];
    expect(rows).toHaveLength(2);

    expect(rows[0]?.textContent).toContain('Notte stellata');
    expect(rows[0]?.textContent).toContain(
      'Artista Audius · in Notte in città e in un’altra raccolta',
    );
    expect(rows[0]?.querySelector('[data-source="mine"]')?.textContent).toBe('La tua playlist');
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/library?playlist=pl-2');

    expect(rows[1]?.textContent).toContain('Canale · in Preferiti');
    expect(rows[1]?.querySelector('[data-source="favorites"]')?.textContent).toBe('Preferiti');
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('/library?playlist=fav-1');
  });

  it('un brano Audius porta la nota di licenza OML come nella Libreria; un video YouTube no', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    const [audius, youtube] = [
      ...(librarySection(container)?.querySelectorAll<HTMLElement>('li[data-kind="library"]') ??
        []),
    ];
    const notice = audius?.querySelector('small');
    expect(notice?.textContent).toContain('© Artista Audius');
    expect(notice?.textContent).toContain('Licenza: Audius Open Music License');
    const links = [...(notice?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
    expect(links).toContain('https://audius.co/artista/notte-stellata');
    expect(notice?.textContent).toContain('Brano su Audius');
    // Il primo link della riga resta «in <playlist>» verso la Libreria.
    expect(audius?.querySelector('a')?.getAttribute('href')).toBe('/library?playlist=pl-2');

    // Stessa nota della riga della Libreria per lo stesso elemento.
    const libraryPage = await render(<MusicCollections />);
    const libraryNotice = [...libraryPage.container.querySelectorAll('small')].find((small) =>
      small.textContent?.includes('Licenza'),
    );
    expect(libraryNotice?.textContent).toContain(
      '© Artista Audius · Licenza: Audius Open Music License',
    );

    expect(youtube?.textContent).not.toContain('Licenza');
    expect(youtube?.querySelector('small')).toBeNull();
  });

  it('su telefono il distintivo sale sopra il titolo e il sottotitolo può andare a capo', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    const row = librarySection(container)?.querySelector<HTMLElement>('li[data-kind="library"]');
    const strong = row?.querySelector('strong');
    const line = strong?.parentElement;
    // Classi dedicate (regole sotto 480px in library-search-results.module.css) accanto a quelle
    // della ricerca: le righe dell'elenco misto non cambiano.
    expect(line?.className).toMatch(/trackTitleLine/);
    expect(strong?.className).toMatch(/trackTitle/);
    expect(row?.querySelector('[class*="trackSub"]')?.textContent).toContain('in Notte in città');
    const mixed = mixedRows(container)[0];
    expect(mixed?.querySelector('[class*="trackTitleLine"]')).toBeNull();
  });

  it('chip coerenti: «Tutto» conta anche la Libreria, «Le tue» mostra solo la sezione, «Radio» la nasconde', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    // 1 radio + 2 raccolte + 2 brani.
    expect(chip(container, 'Tutto')?.textContent).toBe('Tutto 5');
    expect(chip(container, 'Le tue')?.textContent).toBe('Le tue 4');
    expect(container.querySelector('output')?.textContent).toContain('5 risultati per “notte”');

    await act(async () => chip(container, 'Le tue')?.click());
    expect(chip(container, 'Le tue')?.getAttribute('aria-pressed')).toBe('true');
    expect(librarySection(container)).not.toBeNull();
    expect(mixedRows(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('Nessun risultato');

    await act(async () => chip(container, 'Radio')?.click());
    expect(librarySection(container)).toBeNull();
    expect(mixedRows(container)).toHaveLength(1);

    await act(async () => chip(container, 'Tutto')?.click());
    expect(librarySection(container)).not.toBeNull();
    expect(mixedRows(container)).toHaveLength(1);
  });

  it('solo risultati della Libreria: la sezione e «Nessun altro risultato», mai «Nessun risultato»', async () => {
    serve((url) =>
      url.startsWith('/api/music/search-all')
        ? {
            ...searchAll,
            results: [],
            sources: { ...searchAll.sources, radio: { status: 'empty', stations: [] } },
          }
        : defaultHandler(url),
    );
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    expect(librarySection(container)).not.toBeNull();
    expect(container.textContent).toContain('Nessun altro risultato per “notte”.');
    expect(container.textContent).not.toContain('Nessun risultato per');
  });
});

describe('Cerca: un brano della Libreria suona come nella Libreria', () => {
  it('usa collectionItemToTrack e playCollectionItem: brano, percorso e coda dei brani trovati', async () => {
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    const play = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Riproduci Notte stellata dalla tua playlist Notte in città"]',
    );
    expect(play).not.toBeNull();
    await act(async () => play?.click());

    expect(mocks.playTrack).toHaveBeenCalledTimes(1);
    const [track, path, queue] = mocks.playTrack.mock.calls[0] ?? [];
    expect(track).toEqual(collectionItemToTrack(library.tracks[0] as never));
    expect(path).toBe('/stream/audius:trk-1');
    expect(queue).toEqual(collectionQueue(library.tracks));
    expect(track).toMatchObject({ qualifiedId: 'audius:trk-1', sourceLabel: 'Solco · Audius' });

    // Il video dei Preferiti: stesso avvio, nel player ufficiale YouTube (playbackMode youtube).
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Riproduci Notte video dai tuoi Preferiti"]',
        )
        ?.click(),
    );
    expect(mocks.playTrack.mock.calls[1]?.[0]).toMatchObject({
      qualifiedId: 'youtube:dQw4w9WgXcQ',
      playbackMode: 'youtube',
    });
  });

  it('sul brano in corso mette in pausa/riprende, come la Libreria', async () => {
    mocks.currentTrack = { qualifiedId: 'audius:trk-1' };
    const { container } = await render(<UnifiedSearchResults initialQuery="notte" />);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('li[data-kind="library"] button')?.click(),
    );
    expect(mocks.togglePlayback).toHaveBeenCalledTimes(1);
    expect(mocks.playTrack).not.toHaveBeenCalled();
  });

  it('parità con la Libreria: stesso brano del player e stesso percorso per lo stesso elemento', async () => {
    const libraryPage = await render(<MusicCollections />);
    const libraryPlay = [
      ...libraryPage.container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Riproduci su Solco');
    expect(libraryPlay).toBeDefined();
    await act(async () => libraryPlay?.click());

    const search = await render(<UnifiedSearchResults initialQuery="notte" />);
    await act(async () =>
      search.container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Riproduci Notte stellata dalla tua playlist Notte in città"]',
        )
        ?.click(),
    );

    expect(mocks.playTrack).toHaveBeenCalledTimes(2);
    const [fromLibrary, fromSearch] = mocks.playTrack.mock.calls;
    expect(fromSearch?.[0]).toEqual(fromLibrary?.[0]);
    expect(fromSearch?.[1]).toEqual(fromLibrary?.[1]);
  });
});

describe('Libreria: link diretto /library?playlist=<id>', () => {
  it('apre la scheda Playlist, porta in vista la raccolta, la mette in risalto e le dà il focus', async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Element.prototype.scrollIntoView = scrollIntoView;
    // Il link della scheda nella ricerca porta qui.
    const href = libraryPlaylistPath('pl-2');
    mocks.searchParams = new URL(href, 'https://solco.test').searchParams;
    expect(mocks.searchParams.get(LIBRARY_PLAYLIST_PARAM)).toBe('pl-2');

    const { container } = await render(<LibraryView />);
    await flush();

    const target = [...container.querySelectorAll<HTMLElement>('section')].find(
      (section) => section.querySelector('h2')?.textContent === 'Notte in città',
    );
    expect(target?.getAttribute('data-deep-linked')).toBe('true');
    expect(container.querySelectorAll('[data-deep-linked]')).toHaveLength(1);
    expect(scrolled).toEqual([target]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(document.activeElement).toBe(target?.querySelector('h2'));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('con «riduci movimento» lo scorrimento è istantaneo', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    mocks.searchParams = new URLSearchParams({ playlist: 'fav-1' });
    await render(<LibraryView />);
    await flush();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });

  it('una raccolta che non è (più) nella Libreria: un avviso, nessuno scorrimento', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mocks.searchParams = new URLSearchParams({ playlist: 'altrui' });
    const { container } = await render(<LibraryView />);
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith('Questa raccolta non è più nella tua Libreria.');
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.querySelector('[data-deep-linked]')).toBeNull();
  });

  it('senza il parametro la Libreria resta com’era: nessuno scorrimento né risalto', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = await render(<LibraryView />);
    await flush();
    expect(container.textContent).toContain('Notte in città');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.querySelector('[data-deep-linked]')).toBeNull();
  });
});
