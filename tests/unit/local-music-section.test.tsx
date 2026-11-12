// @polsia:user-owned — "La tua musica" in Libreria: file dell'ascoltatore salvati solo sul dispositivo.
// Libreria locale e player sono finti: aggiunta (FileList vivo svuotato solo dopo la copia),
// avanzamento (barra con valore, annunci diradati, sopravvive a un nuovo montaggio), riepilogo con
// i motivi in italiano, riproduzione e coda (anche casuale), rimozione singola e totale con
// conferma (il player dimentica i file), copertine solo vicino allo schermo e revocate, elenco
// lungo con "Mostra tutti", suggerimenti per iPhone, browser senza supporto, nessuna richiesta di
// rete. Più il montaggio come prima sezione della Libreria, anche offline.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AddFilesOptions,
  AddFilesResult,
  LocalTrack,
  PersistenceResult,
} from '@/lib/local-music';

type FakeHandle = { id: string; url: string; revoked: boolean };

const lib = vi.hoisted(() => {
  const state = {
    tracks: [] as LocalTrack[],
    bytes: null as number | null,
    handles: [] as FakeHandle[],
    serial: 0,
  };
  return {
    state,
    isLocalMusicSupported: vi.fn(() => true),
    listTracks: vi.fn(async () => [...state.tracks]),
    usage: vi.fn(async () => ({
      tracks: state.tracks.length,
      bytes: state.bytes ?? state.tracks.reduce((sum, track) => sum + track.size, 0),
      quota: null,
      available: null,
    })),
    addFiles: vi.fn(
      async (files: ArrayLike<File>, _options?: AddFilesOptions): Promise<AddFilesResult> => {
        Array.from(files);
        return { added: [], skipped: [] };
      },
    ),
    removeTrack: vi.fn(async (id: string) => {
      state.tracks = state.tracks.filter((track) => track.id !== id);
    }),
    clearAll: vi.fn(async () => {
      state.tracks = [];
    }),
    requestPersistence: vi.fn(async (): Promise<PersistenceResult> => 'granted'),
    createObjectUrlForArtwork: vi.fn(async (id: string) => {
      state.serial += 1;
      const handle: FakeHandle = {
        id,
        url: `blob:http://localhost:3000/cover-${id}-${state.serial}`,
        revoked: false,
      };
      state.handles.push(handle);
      return {
        url: handle.url,
        revoke: () => {
          handle.revoked = true;
        },
      };
    }),
  };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));

type FakePlayer = {
  currentTrack: { qualifiedId: string; playbackMode?: string } | null;
  status: string;
  durationSeconds: number;
  playTrack: ReturnType<typeof vi.fn>;
  togglePlayback: ReturnType<typeof vi.fn>;
  stopPlayback: ReturnType<typeof vi.fn>;
  forgetLocalTracks: ReturnType<typeof vi.fn>;
};
const playerState = vi.hoisted(() => ({ value: null as FakePlayer | null }));
const network = vi.hoisted(() => ({ apiFetch: vi.fn(async () => ({})) }));
const libraryState = vi.hoisted(() => ({ signedIn: false }));

vi.mock('@/lib/local-music', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/local-music')>();
  return {
    ...actual,
    isLocalMusicSupported: lib.isLocalMusicSupported,
    listTracks: lib.listTracks,
    usage: lib.usage,
    addFiles: lib.addFiles,
    removeTrack: lib.removeTrack,
    clearAll: lib.clearAll,
    requestPersistence: lib.requestPersistence,
    createObjectUrlForArtwork: lib.createObjectUrlForArtwork,
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/components/custom/music/music-player', () => ({
  useOptionalMusicPlayer: () => playerState.value,
  useMusicPlayer: () => playerState.value,
  trackStreamPath: () => null,
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: network.apiFetch }));
// Only for the LibraryView mount test: the other Library tabs are not under test here.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/library',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({
    signedIn: libraryState.signedIn,
    library: { folders: [], stations: [], podcasts: [], history: [] },
    mutate: vi.fn(async () => true),
  }),
}));
vi.mock('@/components/custom/music/recently-played-row', () => ({
  useHistoryPlayback: () => ({ isPlaying: () => false, play: vi.fn() }),
}));
vi.mock('@/components/custom/music/music-collections', () => ({
  MusicCollections: () => <p>Playlist finte</p>,
}));
vi.mock('@/components/custom/music/spotify-import', () => ({ SpotifyImport: () => null }));
vi.mock('@/components/custom/music/track-list-import', () => ({ TrackListImport: () => null }));

import { LIBRARY_OFFLINE_MESSAGE, LibraryView } from '@/components/custom/music/library-view';
import {
  formatBytes,
  formatTrackDuration,
  HOME_SCREEN_HINT,
  INITIAL_VISIBLE_ROWS,
  IOS_FILES_HINT,
  importSummary,
  isIosBrowserTab,
  isIosDevice,
  LOCAL_MUSIC_ACCEPT,
  LOCAL_MUSIC_PRIVACY_LINE,
  LOCAL_MUSIC_READ_ERROR,
  LOCAL_MUSIC_UNSUPPORTED_MESSAGE,
  LocalMusicSection,
  MAX_LIVE_COVERS,
  SKIP_REASON_LABELS,
  shuffledCopy,
  usageLine,
} from '@/components/custom/music/local-music-section';
import { localTrackToPlayerTrack } from '@/components/custom/music/local-tracks';
import { LocalMusicUnavailableError } from '@/lib/local-music';

const MIB = 1024 * 1024;
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

function localFile(id: string, overrides: Partial<LocalTrack> = {}): LocalTrack {
  return {
    id,
    title: `Brano ${id}`,
    artist: 'Artista di prova',
    album: 'Album di prova',
    durationSeconds: 180,
    mimeType: 'audio/mp4',
    size: 2 * MIB,
    addedAt: 1,
    hasArtwork: true,
    ...overrides,
  };
}

const trackA = localFile('aaaa-1111', {
  title: 'Alba sul tetto',
  artist: 'Coro Uno',
  album: 'Prove generali',
  durationSeconds: 124.11,
  addedAt: 3,
});
const trackB = localFile('bbbb-2222', {
  title: 'Binario nove',
  artist: 'Banda Due',
  album: null,
  durationSeconds: 99.44,
  addedAt: 2,
});
const trackC = localFile('cccc-3333', {
  title: 'Cortile',
  artist: null,
  album: null,
  durationSeconds: null,
  mimeType: 'audio/mpeg',
  addedAt: 1,
  hasArtwork: false,
});

function makePlayer(overrides: Partial<FakePlayer> = {}): FakePlayer {
  return {
    currentTrack: null,
    status: 'idle',
    durationSeconds: 0,
    playTrack: vi.fn(async () => undefined),
    togglePlayback: vi.fn(async () => undefined),
    stopPlayback: vi.fn(),
    forgetLocalTracks: vi.fn(),
    ...overrides,
  };
}

const roots: Root[] = [];
let container: HTMLDivElement;
const fetchSpy = vi.fn();
const beaconSpy = vi.fn(() => true);
const xhrOpen = vi.fn();

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderSection(node = <LocalMusicSection />) {
  container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await settle();
  return root;
}

function buttonByText(text: string, scope: ParentNode = container): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Nessun pulsante «${text}»`);
  return button;
}

function buttonByLabel(label: string, scope: ParentNode = container): HTMLButtonElement {
  const button = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Nessun pulsante con etichetta «${label}»`);
  return button;
}

function rows(): HTMLLIElement[] {
  return [...container.querySelectorAll<HTMLLIElement>('li')];
}

/** The polite live region: what a screen reader hears (start, every ~10 files, end). */
function statusText(): string {
  return container.querySelector('output[aria-live="polite"]')?.textContent ?? '';
}

/** The visible progress line: updated on every file. */
function visibleProgress(): string {
  return container.querySelector('[data-import-progress]')?.textContent ?? '';
}

function liveCovers() {
  return lib.state.handles.filter((handle) => !handle.revoked);
}

function manyTracks(count: number): LocalTrack[] {
  return Array.from({ length: count }, (_, index) =>
    localFile(`many-${String(index).padStart(3, '0')}`, {
      title: `Brano ${index + 1}`,
      addedAt: count - index,
    }),
  );
}

/** IntersectionObserver for jsdom: the test says which rows are near the screen. */
class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  readonly observed = new Set<Element>();
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.last = this;
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  report(ids: readonly string[], isIntersecting: boolean) {
    const entries = [...this.observed]
      .filter((element) => ids.includes((element as HTMLElement).dataset.localId ?? ''))
      .map((target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/**
 * Like a real <input type=file>: `files` is a live FileList that `input.value = ''` empties. A
 * component that reset the input before addFiles copied the list would hand it nothing.
 */
function chooseFiles(input: HTMLInputElement, files: File[]) {
  const live = [...files];
  const list: Record<number, File | undefined> & { length: number; item(i: number): File | null } =
    {
      length: 0,
      item: (i: number) => live[i] ?? null,
    };
  Object.defineProperty(list, 'length', { get: () => live.length });
  files.forEach((_, index) => {
    Object.defineProperty(list, index, { get: () => live[index], enumerable: true });
  });
  Object.defineProperty(input, 'files', { configurable: true, get: () => list });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => (live[0] ? `C:\\fakepath\\${live[0].name}` : ''),
    set: (value: string) => {
      if (value === '') live.length = 0;
    },
  });
  return live;
}

function fileInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Nessun <input type=file>');
  return input;
}

async function importFiles(result: AddFilesResult, names = ['uno.mp3']) {
  lib.addFiles.mockImplementationOnce(async (files: ArrayLike<File>) => {
    Array.from(files);
    return result;
  });
  const input = fileInput();
  chooseFiles(
    input,
    names.map((name) => new File(['x'], name, { type: 'audio/mpeg' })),
  );
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function openRowMenu(title: string) {
  const trigger = buttonByLabel(`Altre azioni per ${title}`);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
    node.textContent?.includes('Rimuovi da questo dispositivo'),
  );
  if (!item) throw new Error('Voce «Rimuovi da questo dispositivo» assente');
  return item;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  lib.state.tracks = [trackA, trackB, trackC];
  lib.state.bytes = 48 * MIB;
  lib.state.handles = [];
  lib.state.serial = 0;
  lib.isLocalMusicSupported.mockReturnValue(true);
  lib.requestPersistence.mockResolvedValue('granted');
  playerState.value = makePlayer();
  libraryState.signedIn = false;
  fetchSpy.mockReset();
  beaconSpy.mockClear();
  xhrOpen.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: beaconSpy,
  });
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(xhrOpen);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  try {
    // Nothing in this section may ever reach the network.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(network.apiFetch).not.toHaveBeenCalled();
  } finally {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('La tua musica: elenco', () => {
  it('mostra titolo, la riga sulla privacy, copertine, artista · album, durata e spazio usato', async () => {
    await renderSection();
    expect(container.querySelector('h2')?.textContent).toBe('La tua musica');
    expect(container.textContent).toContain(LOCAL_MUSIC_PRIVACY_LINE);
    expect(container.querySelector('section')?.id).toBe('la-tua-musica');

    const [rowA, rowB, rowC] = rows();
    expect(rows()).toHaveLength(3);
    expect(rowA?.querySelector('img')?.getAttribute('src')).toMatch(/^blob:.*cover-aaaa-1111-/);
    expect(rowA?.textContent).toContain('Alba sul tetto');
    expect(rowA?.textContent).toContain('Coro Uno · Prove generali');
    expect(rowA?.textContent).toContain('2:04');
    expect(rowB?.textContent).toContain('Banda Due');
    expect(rowB?.textContent).not.toContain('·');
    expect(rowB?.textContent).toContain('1:39');
    // No cover: the initial instead, and no artwork URL requested for it.
    expect(rowC?.querySelector('img')).toBeNull();
    expect(rowC?.textContent).toContain('Artista sconosciuto');
    expect(lib.createObjectUrlForArtwork.mock.calls.map(([id]) => id)).toEqual([
      'aaaa-1111',
      'bbbb-2222',
    ]);

    expect(container.querySelector('footer')?.textContent).toContain(
      '3 brani · 48 MB su questo dispositivo',
    );
    expect(buttonByText('Riproduci tutto')).toBeTruthy();
    expect(buttonByText('Casuale').getAttribute('aria-label')).toBe('Riproduci in ordine casuale');
    // Covers are plain lazy <img> (next/image would load blob: URLs eagerly).
    const cover = rowA?.querySelector('img');
    expect(cover?.getAttribute('loading')).toBe('lazy');
    expect(cover?.getAttribute('decoding')).toBe('async');
    expect(cover?.getAttribute('alt')).toBe('');
  });

  it('senza brani mostra lo stato vuoto con il pulsante per aggiungerli', async () => {
    lib.state.tracks = [];
    await renderSection();
    expect(container.textContent).toContain('Nessun brano su questo dispositivo.');
    expect(buttonByText('Aggiungi brani')).toBeTruthy();
    expect(container.textContent).not.toContain('Riproduci tutto');
    expect(container.querySelector('footer')).toBeNull();
  });

  it('allo smontaggio revoca tutte le copertine, anche quelle arrivate dopo', async () => {
    let lateCover: ((value: { url: string; revoke: () => void }) => void) | null = null;
    const late = { revoked: false };
    lib.createObjectUrlForArtwork.mockImplementation(async (id: string) => {
      if (id === 'bbbb-2222') {
        return new Promise((done) => {
          lateCover = done;
        });
      }
      const handle = { id, url: `blob:http://localhost:3000/cover-${id}`, revoked: false };
      lib.state.handles.push(handle);
      return {
        url: handle.url,
        revoke: () => {
          handle.revoked = true;
        },
      };
    });
    const root = await renderSection();
    expect(lib.state.handles.map((handle) => handle.revoked)).toEqual([false]);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(lib.state.handles.every((handle) => handle.revoked)).toBe(true);
    // The cover that was still being read when the section went away is revoked on arrival.
    await act(async () => {
      lateCover?.({
        url: 'blob:http://localhost:3000/late',
        revoke: () => {
          late.revoked = true;
        },
      });
    });
    expect(late.revoked).toBe(true);
  });
});

describe('La tua musica: aggiunta dei file', () => {
  it('apre il selettore, copia la lista prima di svuotare l’input e mostra «n di m»', async () => {
    lib.state.tracks = [];
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await renderSection();

    const input = fileInput();
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(LOCAL_MUSIC_ACCEPT);
    expect(LOCAL_MUSIC_ACCEPT).toBe('audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg');
    const add = buttonByText('Aggiungi brani');
    await act(async () => add.click());
    expect(pickerClick).toHaveBeenCalledTimes(1);

    let finish: ((result: AddFilesResult) => void) | null = null;
    let report: AddFilesOptions['onProgress'];
    let received: string[] = [];
    lib.addFiles.mockImplementationOnce((files: ArrayLike<File>, options?: AddFilesOptions) => {
      // What the real addFiles does first: a synchronous copy of the live FileList.
      received = Array.from(files, (file) => file.name);
      report = options?.onProgress;
      return new Promise<AddFilesResult>((done) => {
        finish = done;
      });
    });
    const live = chooseFiles(input, [
      new File(['a'], 'uno.mp3', { type: 'audio/mpeg' }),
      new File(['b'], 'due.m4a', { type: 'audio/mp4' }),
    ]);
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(received).toEqual(['uno.mp3', 'due.m4a']);
    // Emptied only after the copy, so the same file can be chosen again.
    expect(live).toHaveLength(0);
    expect(input.value).toBe('');
    // <output> is a status live region (implicit role="status").
    const status = container.querySelector('output');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(statusText()).toBe('Aggiungo i brani: 0 di 2');
    expect(visibleProgress()).toBe('Aggiungo i brani: 0 di 2');
    await act(async () => report?.({ processed: 1, total: 2, fileName: 'uno.mp3' }));
    // Seen at once; spoken only at the start, every ~10 files and at the end.
    expect(visibleProgress()).toBe('Aggiungo i brani: 1 di 2');
    expect(statusText()).toBe('Aggiungo i brani: 0 di 2');
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('50');
    expect(bar?.getAttribute('aria-valuetext')).toBe('1 di 2');
    expect(bar?.getAttribute('data-state')).toBe('loading');

    // While importing the button stays focusable but does not open a second picker.
    expect(add.getAttribute('aria-disabled')).toBe('true');
    await act(async () => add.click());
    expect(pickerClick).toHaveBeenCalledTimes(1);

    const added = [localFile('new-1', { title: 'Uno' }), localFile('new-2', { title: 'Due' })];
    lib.state.tracks = added;
    await act(async () => finish?.({ added, skipped: [] }));
    await settle();

    expect(toastMock.success).toHaveBeenCalledWith('2 brani aggiunti', undefined);
    expect(statusText()).toBe('');
    expect(add.hasAttribute('aria-disabled')).toBe(false);
    // Same element before and after the list appears (focus is not lost).
    expect(add.isConnected).toBe(true);
    expect(rows().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Uno', 'Due']);
    expect(lib.requestPersistence).toHaveBeenCalledTimes(1);

    // A later import does not ask the browser again.
    await importFiles({ added: [localFile('new-3')], skipped: [] });
    expect(lib.requestPersistence).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenLastCalledWith('1 brano aggiunto', undefined);
  });

  it('il riepilogo dice in italiano perché i file sono stati saltati', async () => {
    await renderSection();
    await importFiles(
      {
        added: [localFile('new-1')],
        skipped: [
          { name: 'nota.wma', reason: 'unsupported' },
          { name: 'concerto.wav', reason: 'too_large' },
          { name: 'Alba sul tetto.m4a', reason: 'duplicate' },
          { name: 'lungo.flac', reason: 'quota' },
          { name: 'rotto.mp3', reason: 'error' },
        ],
      },
      ['a.mp3', 'b.wma', 'c.wav', 'd.m4a', 'e.flac', 'f.mp3'],
    );
    expect(toastMock.success).toHaveBeenCalledWith('1 brano aggiunto', {
      description:
        'Non aggiunti: nota.wma (formato non supportato), concerto.wav (troppo grande (oltre 200 MB)), ' +
        'Alba sul tetto.m4a (già presente), lungo.flac (spazio esaurito) e altri 1. ' +
        'Libera spazio sul dispositivo e riprova.',
    });

    toastMock.success.mockClear();
    await importFiles({ added: [], skipped: [{ name: 'rotto.mp3', reason: 'error' }] });
    expect(toastMock.error).toHaveBeenCalledWith('Nessun brano aggiunto', {
      description: 'Non aggiunto: rotto.mp3 (errore).',
    });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('elenca i cinque motivi con le parole richieste', () => {
    expect(SKIP_REASON_LABELS).toEqual({
      unsupported: 'formato non supportato',
      too_large: 'troppo grande (oltre 200 MB)',
      duplicate: 'già presente',
      quota: 'spazio esaurito',
      error: 'errore',
    });
    const summary = importSummary({
      added: [localFile('x'), localFile('y'), localFile('z')],
      skipped: [],
    });
    expect(summary).toEqual({ tone: 'success', title: '3 brani aggiunti', description: null });
  });

  it('se la libreria non si apre durante l’aggiunta lo dice con un toast', async () => {
    await renderSection();
    lib.addFiles.mockImplementationOnce(async (files: ArrayLike<File>) => {
      Array.from(files);
      throw new LocalMusicUnavailableError();
    });
    const input = fileInput();
    chooseFiles(input, [new File(['x'], 'uno.mp3', { type: 'audio/mpeg' })]);
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(toastMock.error).toHaveBeenCalledWith(LOCAL_MUSIC_UNSUPPORTED_MESSAGE);
    expect(statusText()).toBe('');
    expect(lib.requestPersistence).not.toHaveBeenCalled();
  });
});

describe('La tua musica: riproduzione', () => {
  it('ogni riga suona dal proprio brano con tutta la libreria in coda', async () => {
    await renderSection();
    const player = playerState.value as FakePlayer;
    await act(async () => buttonByLabel('Riproduci Binario nove').click());
    const queue = [trackA, trackB, trackC].map(localTrackToPlayerTrack);
    expect(player.playTrack).toHaveBeenCalledWith(queue[1], '', queue);

    await act(async () => buttonByText('Riproduci tutto').click());
    expect(player.playTrack).toHaveBeenLastCalledWith(queue[0], '', queue);
  });

  it('«Casuale» mescola la coda e parte dal primo brano mescolato', async () => {
    await renderSection();
    const player = playerState.value as FakePlayer;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await act(async () => buttonByText('Casuale').click());
    const expected = shuffledCopy([trackA, trackB, trackC], () => 0).map(localTrackToPlayerTrack);
    expect(expected.map((item) => item.qualifiedId)).toEqual([
      'local:bbbb-2222',
      'local:cccc-3333',
      'local:aaaa-1111',
    ]);
    expect(player.playTrack).toHaveBeenCalledWith(expected[0], '', expected);
  });

  it('evidenzia il brano in riproduzione e lo mette in pausa invece di ripartire', async () => {
    playerState.value = makePlayer({
      currentTrack: { qualifiedId: 'local:bbbb-2222', playbackMode: 'local' },
      status: 'playing',
    });
    await renderSection();
    const [rowA, rowB] = rows();
    expect(rowA?.hasAttribute('aria-current')).toBe(false);
    expect(rowB?.getAttribute('aria-current')).toBe('true');
    expect(rowB?.textContent).toContain('in riproduzione');
    await act(async () => buttonByLabel('Metti in pausa Binario nove').click());
    expect(playerState.value?.togglePlayback).toHaveBeenCalledTimes(1);
    expect(playerState.value?.playTrack).not.toHaveBeenCalled();
  });

  it('per un brano senza durata salvata usa quella che il player conosce', async () => {
    playerState.value = makePlayer({
      currentTrack: { qualifiedId: 'local:cccc-3333', playbackMode: 'local' },
      status: 'paused',
      durationSeconds: 97.83,
    });
    await renderSection();
    const rowC = rows()[2];
    expect(rowC?.textContent).toContain('1:37');
    expect(buttonByLabel('Riprendi Cortile')).toBeTruthy();
  });
});

describe('La tua musica: rimozione', () => {
  it('«Rimuovi da questo dispositivo» cancella il brano, revoca la copertina e sposta il focus', async () => {
    await renderSection();
    const item = await openRowMenu('Alba sul tetto');
    await act(async () => item.click());
    await settle();

    expect(lib.removeTrack).toHaveBeenCalledWith('aaaa-1111');
    expect(rows()).toHaveLength(2);
    expect(toastMock.success).toHaveBeenCalledWith(
      '“Alba sul tetto” rimosso da questo dispositivo',
    );
    const coverA = lib.state.handles.find((handle) => handle.id === 'aaaa-1111');
    const coverB = lib.state.handles.find((handle) => handle.id === 'bbbb-2222');
    expect(coverA?.revoked).toBe(true);
    expect(coverB?.revoked).toBe(false);
    // The row that took its place gets the focus (not the page body).
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Riproduci Binario nove');
    expect(container.querySelector('footer')?.textContent).toContain('2 brani');
    expect(playerState.value?.stopPlayback).not.toHaveBeenCalled();
  });

  it('rimuovere un brano lo toglie anche dal player (che si ferma se era quello in corso)', async () => {
    playerState.value = makePlayer({
      currentTrack: { qualifiedId: 'local:cccc-3333', playbackMode: 'local' },
      status: 'playing',
    });
    await renderSection();
    const item = await openRowMenu('Cortile');
    await act(async () => item.click());
    await settle();
    expect(lib.removeTrack).toHaveBeenCalledWith('cccc-3333');
    expect(playerState.value?.forgetLocalTracks).toHaveBeenCalledWith(['cccc-3333']);
    // The last row went: the focus moves to the row before it.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Riproduci Binario nove');
  });

  it('«Rimuovi tutti» chiede conferma; Annulla non cancella nulla', async () => {
    playerState.value = makePlayer({
      currentTrack: { qualifiedId: 'local:aaaa-1111', playbackMode: 'local' },
      status: 'playing',
    });
    await renderSection();
    await act(async () => buttonByText('Rimuovi tutti').click());
    let dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Rimuovere tutti i brani da questo dispositivo?');
    expect(dialog?.textContent).toContain('I 3 brani e le loro copertine vengono cancellati');
    expect(lib.clearAll).not.toHaveBeenCalled();
    await act(async () => buttonByText('Annulla', dialog as Element).click());
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(lib.clearAll).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);

    let finishClear: (() => void) | null = null;
    lib.clearAll.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          finishClear = () => {
            lib.state.tracks = [];
            done();
          };
        }),
    );
    await act(async () => buttonByText('Rimuovi tutti').click());
    dialog = document.querySelector('[role="alertdialog"]');
    const confirm = buttonByText('Rimuovi tutti', dialog as Element);
    await act(async () => confirm.click());
    await settle();
    // Still open (and busy) until the device copy is really gone.
    expect(lib.clearAll).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await act(async () => confirm.click());
    expect(lib.clearAll).toHaveBeenCalledTimes(1);
    await act(async () => finishClear?.());
    await settle();

    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).toContain('Nessun brano su questo dispositivo.');
    expect(container.querySelector('footer')).toBeNull();
    expect(lib.state.handles.length).toBeGreaterThan(0);
    expect(lib.state.handles.every((handle) => handle.revoked)).toBe(true);
    expect(playerState.value?.forgetLocalTracks).toHaveBeenCalledWith('all');
    expect(toastMock.success).toHaveBeenCalledWith(
      'Tutti i brani sono stati rimossi da questo dispositivo',
    );
    expect(document.activeElement).toBe(buttonByText('Aggiungi brani'));
  });

  it('«Rimuovi tutti» non ferma un brano in streaming che non è sul dispositivo', async () => {
    playerState.value = makePlayer({
      currentTrack: { qualifiedId: 'audius:abc', playbackMode: 'audius' },
      status: 'playing',
    });
    await renderSection();
    await act(async () => buttonByText('Rimuovi tutti').click());
    const dialog = document.querySelector('[role="alertdialog"]');
    await act(async () => buttonByText('Rimuovi tutti', dialog as Element).click());
    await settle();
    expect(lib.clearAll).toHaveBeenCalledTimes(1);
    // Only the local files leave the player (it decides); the stream is not stopped from here.
    expect(playerState.value?.forgetLocalTracks).toHaveBeenCalledWith('all');
    expect(playerState.value?.stopPlayback).not.toHaveBeenCalled();
  });
});

describe('La tua musica: spazio persistente e iPhone', () => {
  it('su iPhone in Safari, se il browser non garantisce lo spazio, suggerisce la schermata Home', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
    lib.requestPersistence.mockResolvedValue('denied');
    await renderSection();
    expect(container.textContent).not.toContain(HOME_SCREEN_HINT);
    await importFiles({ added: [localFile('new-1')], skipped: [] });
    expect(lib.requestPersistence).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(HOME_SCREEN_HINT);
    // Announced when it appears (an <output> is a status region).
    const hint = [...container.querySelectorAll('output')].find((node) =>
      node.textContent?.includes(HOME_SCREEN_HINT),
    );
    expect(hint).toBeTruthy();
  });

  it('su iPhone in Safari lo stato vuoto avvisa prima di aggiungere, senza chiedere nulla', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
    lib.state.tracks = [];
    await renderSection();
    expect(container.textContent).toContain(HOME_SCREEN_HINT);
    expect(HOME_SCREEN_HINT).toContain('iPhone e iPad');
    expect(HOME_SCREEN_HINT).toContain('separato da Safari');
    expect(container.textContent).toContain(IOS_FILES_HINT);
    expect(lib.requestPersistence).not.toHaveBeenCalled();
  });

  it('dall’icona sulla schermata Home resta solo il consiglio sull’app File', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    try {
      lib.state.tracks = [];
      await renderSection();
      expect(container.textContent).not.toContain(HOME_SCREEN_HINT);
      expect(container.textContent).toContain(IOS_FILES_HINT);
    } finally {
      Reflect.deleteProperty(navigator, 'standalone');
    }
  });

  it('fuori da iOS lo stato vuoto non parla di iPhone', async () => {
    lib.state.tracks = [];
    await renderSection();
    expect(container.textContent).not.toContain(HOME_SCREEN_HINT);
    expect(container.textContent).not.toContain(IOS_FILES_HINT);
  });

  it('niente suggerimento se lo spazio è garantito, o fuori da iOS', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
    lib.requestPersistence.mockResolvedValue('granted');
    await renderSection();
    await importFiles({ added: [localFile('new-1')], skipped: [] });
    expect(container.textContent).not.toContain(HOME_SCREEN_HINT);

    vi.restoreAllMocks();
    vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(xhrOpen);
    lib.requestPersistence.mockResolvedValue('denied');
    await renderSection();
    await importFiles({ added: [localFile('new-2')], skipped: [] });
    expect(container.textContent).not.toContain(HOME_SCREEN_HINT);
  });

  it('riconosce iPhone e iPad (anche con UA da Mac) fuori dalla schermata Home', () => {
    expect(isIosBrowserTab({ userAgent: IPHONE_UA })).toBe(true);
    expect(isIosBrowserTab({ userAgent: IPHONE_UA, standalone: true })).toBe(false);
    expect(isIosBrowserTab({ userAgent: IPHONE_UA, displayModeStandalone: true })).toBe(false);
    const ipadOs =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
    expect(isIosBrowserTab({ userAgent: ipadOs, maxTouchPoints: 5 })).toBe(true);
    expect(isIosBrowserTab({ userAgent: ipadOs, maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: IPHONE_UA, standalone: true })).toBe(true);
    expect(
      isIosBrowserTab({
        userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131.0 Mobile',
      }),
    ).toBe(false);
  });
});

describe('La tua musica: browser senza supporto o libreria illeggibile', () => {
  it('senza IndexedDB lo dice e non offre l’aggiunta', async () => {
    lib.isLocalMusicSupported.mockReturnValue(false);
    await renderSection();
    expect(container.textContent).toContain(LOCAL_MUSIC_UNSUPPORTED_MESSAGE);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.textContent).not.toContain('Aggiungi brani');
    expect(lib.listTracks).not.toHaveBeenCalled();
  });

  it('se IndexedDB non si apre (modalità privata) mostra lo stesso messaggio', async () => {
    lib.listTracks.mockRejectedValueOnce(new LocalMusicUnavailableError());
    await renderSection();
    expect(container.textContent).toContain(LOCAL_MUSIC_UNSUPPORTED_MESSAGE);
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it('un errore di lettura momentaneo offre «Riprova»', async () => {
    lib.listTracks.mockRejectedValueOnce(new Error('UnknownError'));
    await renderSection();
    expect(container.textContent).toContain(LOCAL_MUSIC_READ_ERROR);
    expect(LOCAL_MUSIC_READ_ERROR).toBe(
      'Non riesco a leggere i brani salvati su questo dispositivo.',
    );
    await act(async () => buttonByText('Riprova').click());
    await settle();
    expect(rows()).toHaveLength(3);
  });
});

describe('La tua musica: libreria grande', () => {
  it('500 brani: 20 righe, poche copertine, «Mostra tutti» e «Mostra meno» con il focus giusto', async () => {
    lib.state.tracks = manyTracks(500);
    await renderSection();
    expect(rows()).toHaveLength(INITIAL_VISIBLE_ROWS);
    expect(lib.createObjectUrlForArtwork.mock.calls.length).toBeLessThanOrEqual(
      INITIAL_VISIBLE_ROWS,
    );
    expect(container.querySelectorAll('img').length).toBeLessThanOrEqual(INITIAL_VISIBLE_ROWS);
    expect(container.querySelector('footer')?.textContent).toContain('500 brani');

    const toggle = buttonByText('Mostra tutti i 500 brani');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('local-music-list');
    await act(async () => toggle.click());
    await settle();
    expect(rows()).toHaveLength(500);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Riproduci Brano 21');
    // Without an IntersectionObserver only the first rows get a cover, never all 500.
    expect(liveCovers().length).toBeLessThanOrEqual(MAX_LIVE_COVERS);
    expect(lib.createObjectUrlForArtwork.mock.calls.length).toBeLessThanOrEqual(MAX_LIVE_COVERS);

    const less = buttonByText('Mostra meno');
    expect(less.getAttribute('aria-expanded')).toBe('true');
    await act(async () => less.click());
    await settle();
    expect(rows()).toHaveLength(INITIAL_VISIBLE_ROWS);
    expect(document.activeElement).toBe(buttonByText('Mostra tutti i 500 brani'));
  });

  it('con IntersectionObserver le copertine seguono lo schermo, al massimo 60 vive', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const tracks = manyTracks(500);
    lib.state.tracks = tracks;
    await renderSection();
    // Nothing reported near the screen yet: no cover read at all.
    expect(lib.createObjectUrlForArtwork).not.toHaveBeenCalled();
    const observer = FakeIntersectionObserver.last as FakeIntersectionObserver;
    expect(observer.options?.rootMargin).toBe('100% 0px');

    await act(async () => buttonByText('Mostra tutti i 500 brani').click());
    await settle();
    expect(observer.observed.size).toBe(500);
    const ids = tracks.map((track) => track.id);
    await act(async () => observer.report(ids.slice(0, 8), true));
    await settle();
    expect(lib.createObjectUrlForArtwork.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 8));
    expect(rows()[0]?.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
    expect(rows()[8]?.querySelector('img')).toBeNull();

    // Scrolling through: beyond 60 live covers the ones seen longest ago are revoked.
    for (let start = 8; start < 200; start += 8) {
      await act(async () => {
        observer.report(ids.slice(start - 8, start), false);
        observer.report(ids.slice(start, start + 8), true);
      });
      await settle(2);
    }
    expect(liveCovers().length).toBeLessThanOrEqual(MAX_LIVE_COVERS);
    const live = new Set(liveCovers().map((handle) => handle.id));
    expect(ids.slice(192, 200).every((id) => live.has(id))).toBe(true);
    expect(live.has(ids[0] as string)).toBe(false);
  });
});

describe('La tua musica: aggiunta che continua', () => {
  it('lasciando la Libreria a metà, il nuovo montaggio vede l’avanzamento e il risultato', async () => {
    lib.state.tracks = [];
    let finish: ((result: AddFilesResult) => void) | null = null;
    let report: AddFilesOptions['onProgress'];
    lib.addFiles.mockImplementationOnce((files: ArrayLike<File>, options?: AddFilesOptions) => {
      Array.from(files);
      report = options?.onProgress;
      return new Promise<AddFilesResult>((done) => {
        finish = done;
      });
    });
    const first = await renderSection();
    const input = fileInput();
    chooseFiles(input, [
      new File(['a'], 'uno.mp3', { type: 'audio/mpeg' }),
      new File(['b'], 'due.mp3', { type: 'audio/mpeg' }),
    ]);
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => report?.({ processed: 1, total: 2, fileName: 'uno.mp3' }));
    await act(async () => first.unmount());
    roots.splice(roots.indexOf(first), 1);
    document.body.innerHTML = '';

    await renderSection();
    expect(visibleProgress()).toBe('Aggiungo i brani: 1 di 2');
    const add = buttonByText('Aggiungi brani');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    // No second import while the first is running.
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await act(async () => add.click());
    expect(pickerClick).not.toHaveBeenCalled();

    const added = [localFile('new-1', { title: 'Uno' }), localFile('new-2', { title: 'Due' })];
    lib.state.tracks = added;
    await act(async () => finish?.({ added, skipped: [] }));
    await settle();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith('2 brani aggiunti', undefined);
    expect(visibleProgress()).toBe('');
    expect(rows().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Uno', 'Due']);
    expect(lib.addFiles).toHaveBeenCalledTimes(1);
  });

  it('gli annunci per i lettori di schermo sono diradati, la riga visibile no', async () => {
    lib.state.tracks = [];
    let finish: ((result: AddFilesResult) => void) | null = null;
    let report: AddFilesOptions['onProgress'];
    lib.addFiles.mockImplementationOnce((files: ArrayLike<File>, options?: AddFilesOptions) => {
      Array.from(files);
      report = options?.onProgress;
      return new Promise<AddFilesResult>((done) => {
        finish = done;
      });
    });
    await renderSection();
    const input = fileInput();
    const names = Array.from({ length: 25 }, (_, index) => `f${index}.mp3`);
    chooseFiles(
      input,
      names.map((name) => new File(['x'], name, { type: 'audio/mpeg' })),
    );
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const spoken = new Set([statusText()]);
    for (let processed = 1; processed <= 25; processed += 1) {
      await act(async () => report?.({ processed, total: 25, fileName: `f${processed}.mp3` }));
      expect(visibleProgress()).toBe(`Aggiungo i brani: ${processed} di 25`);
      spoken.add(statusText());
    }
    expect([...spoken]).toEqual([
      'Aggiungo i brani: 0 di 25',
      'Aggiungo i brani: 10 di 25',
      'Aggiungo i brani: 20 di 25',
      'Aggiungo i brani: 25 di 25',
    ]);
    await act(async () => finish?.({ added: [], skipped: [] }));
    await settle();
  });
});

describe('La tua musica: formati e testi', () => {
  it('durata come nel player e spazio in MB', () => {
    expect(formatTrackDuration(124.11)).toBe('2:04');
    expect(formatTrackDuration(99.44)).toBe('1:39');
    expect(formatTrackDuration(97.83)).toBe('1:37');
    expect(formatTrackDuration(3725)).toBe('1:02:05');
    expect(formatTrackDuration(null)).toBeNull();
    expect(formatTrackDuration(0)).toBeNull();
    expect(formatBytes(48 * MIB)).toBe('48 MB');
    expect(formatBytes(4.25 * MIB)).toBe('4,3 MB');
    expect(formatBytes(1.5 * 1024 * MIB)).toBe('1,5 GB');
    expect(formatBytes(300 * 1024)).toBe('0,3 MB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(0)).toBe('0 MB');
    expect(usageLine(12, 48 * MIB)).toBe('12 brani · 48 MB su questo dispositivo');
    expect(usageLine(1, 3 * MIB)).toBe('1 brano · 3 MB su questo dispositivo');
  });

  it('il mescolamento tiene tutti i brani una volta sola', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const mixed = shuffledCopy(items);
    expect([...mixed].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('il codice della sezione non usa la rete né i servizi di Solco', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/custom/music/local-music-section.tsx'),
      'utf-8',
    );
    expect(source).not.toMatch(
      /apiFetch\(|@\/lib\/api-client|\bfetch\(|sendBeacon|XMLHttpRequest|posthog|['"`]\/api\//,
    );
  });
});

describe('Libreria', () => {
  it('«La tua musica» è la prima sezione, anche senza accesso', async () => {
    libraryState.signedIn = false;
    await renderSection(<LibraryView />);
    const main = container.querySelector('main');
    const firstSection = main?.querySelector(':scope > section');
    expect(firstSection?.id).toBe('la-tua-musica');
    expect(main?.firstElementChild?.tagName).toBe('HEADER');
    expect(main?.children[1]).toBe(firstSection);
    expect(container.textContent).toContain('Accedi per creare playlist');
    expect(rows()).toHaveLength(3);
  });

  it('offline senza sessione: niente link ad Accedi/Registrati, solo una riga neutra', async () => {
    libraryState.signedIn = false;
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await renderSection(<LibraryView />);
    expect(container.textContent).toContain(LIBRARY_OFFLINE_MESSAGE);
    expect(container.textContent).not.toContain('Accedi per creare playlist');
    expect(container.querySelector('a[href="/login"]')).toBeNull();
    expect(container.querySelector('a[href="/signup"]')).toBeNull();
    // La tua musica still works.
    expect(rows()).toHaveLength(3);

    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(container.textContent).not.toContain(LIBRARY_OFFLINE_MESSAGE);
    expect(container.querySelector('a[href="/login"]')).not.toBeNull();
  });

  it('con l’accesso resta in cima, prima delle schede', async () => {
    libraryState.signedIn = true;
    await renderSection(<LibraryView />);
    const main = container.querySelector('main');
    expect(main?.children[1]?.id).toBe('la-tua-musica');
    expect(main?.querySelector('[role="tablist"]')).not.toBeNull();
  });
});
