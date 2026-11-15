// @polsia:user-owned — correzioni della revisione di «Scarica offline» per i brani in evidenza:
// - una copia salvata non vale mai come file dell'ascoltatore (niente pannello "Testo" dai tag del
//   file, attribuzione anche dalla scheda in Home e dalla coda ripristinata);
// - il registro delle copie non si sovrascrive se è illeggibile (le copie resterebbero irrevocabili);
// - una copia già sul dispositivo non si riscarica (nessuna richiesta, nessun download consumato);
// - il pulsante a icona mostra e annuncia lo scaricamento; l'elenco «solo streaming» è breve;
// - la verifica dei permessi gira in ogni pagina (mount globale), con tentativi, ritorno online,
//   ritorno sulla scheda, un solo avviso per verifica e pulizia allo smontaggio.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  addDownloaded: vi.fn(),
  getTrack: vi.fn(),
  listTracks: vi.fn(),
  removeTrack: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  publicUploads: true,
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => mocks.publicUploads }));
vi.mock('@/lib/local-music', () => ({
  addDownloadedTrack: mocks.addDownloaded,
  getTrack: mocks.getTrack,
  listTracks: mocks.listTracks,
  removeTrack: mocks.removeTrack,
  localTrackSource: (track: { source?: string }) => track.source ?? 'local',
  localTrackAttribution: () => null,
}));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: lo stub inoltra ciò che passa il componente.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  canRememberFeaturedCopies,
  FEATURED_OFFLINE_COPIES_CHANGED_EVENT,
  FEATURED_OFFLINE_COPIES_KEY,
  type FeaturedOfflineCopy,
  featuredCopyFor,
  readFeaturedCopies,
  rememberFeaturedCopy,
} from '@/components/custom/music/featured-offline-copies';
import {
  FEATURED_SYNC_MIN_INTERVAL_MS,
  FEATURED_SYNC_RETRY_MS,
  FEATURED_SYNC_REVISIT_MS,
  resetFeaturedSyncForTests,
  startFeaturedOfflineSync,
  useFeaturedOfflineSync,
} from '@/components/custom/music/featured-offline-sync';
import { FeaturedOfflineSyncMount } from '@/components/custom/music/featured-offline-sync-mount';
import { FeaturedOfflineDownload } from '@/components/custom/music/featured-track-list';
import {
  LOCAL_SOURCE_LABEL,
  localTrackToPlayerTrack,
  restoreLocalItems,
} from '@/components/custom/music/local-tracks';
import { lyricsTargetFor } from '@/components/custom/music/lyrics-target';
import {
  downloadOne,
  type OfflineDownloadTarget,
  runOfflineDownloadBatch,
} from '@/components/custom/music/offline-download';
import { SingleOfflineDownloadButton } from '@/components/custom/music/offline-download-button';
import type { LocalTrack } from '@/lib/local-music';

vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: true }),
}));

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';

function localTrack(id: string, extra: Partial<LocalTrack> = {}): LocalTrack {
  return {
    id,
    title: `Brano ${id}`,
    artist: 'Autrice',
    album: null,
    durationSeconds: 200,
    mimeType: 'audio/mpeg',
    sizeBytes: 1000,
    addedAt: 1,
    hasArtwork: false,
    ...extra,
  } as LocalTrack;
}

function copy(localId: string, featuredId: string): FeaturedOfflineCopy {
  return {
    localId,
    featuredId,
    attribution: {
      sourceName: 'Solco · In evidenza',
      sourceUrl: null,
      licenseName: 'Creative Commons Attribuzione (CC BY)',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
      creditLine: '© Band',
    },
    savedAt: 1,
  };
}

function register(...copies: FeaturedOfflineCopy[]) {
  window.localStorage.setItem(FEATURED_OFFLINE_COPIES_KEY, JSON.stringify({ v: 1, copies }));
}

function featuredTarget(shareId: string, title = 'Concessa'): OfflineDownloadTarget {
  return { id: `track-${shareId}`, title, endpoint: { kind: 'featured', shareId } };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

const roots: Array<ReturnType<typeof createRoot>> = [];
async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await flush();
  return { container, root };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', mocks.fetch);
  window.localStorage.clear();
  for (const mock of [
    mocks.fetch,
    mocks.addDownloaded,
    mocks.getTrack,
    mocks.listTracks,
    mocks.removeTrack,
    mocks.toast,
    mocks.toast.success,
    mocks.toast.error,
  ]) {
    mock.mockReset();
  }
  mocks.getTrack.mockImplementation(async (id: string) => localTrack(id));
  mocks.listTracks.mockResolvedValue([]);
  mocks.removeTrack.mockResolvedValue(undefined);
  resetFeaturedSyncForTests();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('una copia di un brano in evidenza non è mai un file dell’ascoltatore', () => {
  it('niente pannello "Testo" (anche se il brano del player arriva con la fonte «La tua musica»)', () => {
    register(copy('copia-1', ID_A));
    const asLocalFile = {
      qualifiedId: 'local:copia-1',
      playbackMode: 'local' as const,
      sourceLabel: LOCAL_SOURCE_LABEL,
      sourceUrl: null,
    };
    expect(lyricsTargetFor(asLocalFile)).toBeNull();
    // Un vero file dell'ascoltatore resta com'era.
    expect(lyricsTargetFor({ ...asLocalFile, qualifiedId: 'local:mio-file' })).toEqual({
      source: 'local',
      id: 'mio-file',
    });
  });

  it('scheda in Home e coda ripristinata: fonte e attribuzione della copia, niente "Testo"', async () => {
    register(copy('copia-1', ID_A));
    const item = localTrackToPlayerTrack(localTrack('copia-1'));
    expect(item).toMatchObject({
      qualifiedId: 'local:copia-1',
      sourceLabel: 'Solco · In evidenza',
      sourceUrl: null,
      playbackMode: 'local',
      credits: ['© Band', 'Licenza: Creative Commons Attribuzione (CC BY)'],
    });
    expect(lyricsTargetFor(item)).toBeNull();

    const restored = await restoreLocalItems(
      [{ ...item, title: '', artistName: '', sourceLabel: LOCAL_SOURCE_LABEL }],
      0,
      async (id) => localTrack(id),
    );
    expect(restored?.items[0]?.sourceLabel).toBe('Solco · In evidenza');
    expect(lyricsTargetFor(restored?.items[0] ?? null)).toBeNull();
    // Un file dell'ascoltatore non cambia.
    expect(localTrackToPlayerTrack(localTrack('mio-file')).sourceLabel).toBe(LOCAL_SOURCE_LABEL);
  });

  it('featuredCopyFor segue il registro quando cambia', () => {
    expect(featuredCopyFor('copia-1')).toBeNull();
    register(copy('copia-1', ID_A));
    expect(featuredCopyFor('copia-1')?.featuredId).toBe(ID_A);
    register(copy('copia-2', ID_B));
    expect(featuredCopyFor('copia-1')).toBeNull();
    expect(featuredCopyFor('copia-2')?.featuredId).toBe(ID_B);
  });
});

describe('registro illeggibile: mai sovrascritto', () => {
  it('JSON rovinato → nessuna nuova copia registrata e niente download (fail closed)', async () => {
    window.localStorage.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"copies": [ rovinato');
    expect(canRememberFeaturedCopies()).toBe(false);
    expect(rememberFeaturedCopy(copy('copia-9', ID_B))).toBe(false);
    // Il contenuto resta quello di prima (le copie già salvate non si perdono).
    expect(window.localStorage.getItem(FEATURED_OFFLINE_COPIES_KEY)).toBe('{"copies": [ rovinato');
    const outcome = await downloadOne(featuredTarget(ID_B));
    expect(outcome.status).toBe('failed');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('forma sconosciuta: stesso trattamento', () => {
    window.localStorage.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"v":2,"voci":[]}');
    expect(rememberFeaturedCopy(copy('copia-9', ID_B))).toBe(false);
  });

  it('un registro valido si aggiorna e lo annuncia', () => {
    const heard = vi.fn();
    window.addEventListener(FEATURED_OFFLINE_COPIES_CHANGED_EVENT, heard);
    expect(rememberFeaturedCopy(copy('copia-1', ID_A))).toBe(true);
    window.removeEventListener(FEATURED_OFFLINE_COPIES_CHANGED_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(readFeaturedCopies().map((item) => item.featuredId)).toEqual([ID_A]);
  });
});

describe('copie già sul dispositivo: nessun nuovo download', () => {
  it('registrata e ancora nella libreria → «già presente» senza richiesta', async () => {
    register(copy('copia-1', ID_A));
    const outcome = await downloadOne(featuredTarget(ID_A));
    expect(outcome.status).toBe('already');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getTrack).toHaveBeenCalledWith('copia-1');
  });

  it('registrata ma il file non c’è più → voce dimenticata, si scarica di nuovo', async () => {
    register(copy('copia-1', ID_A));
    mocks.getTrack.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue(
      Response.json({ error: 'offline_not_allowed', message: 'Revocato.' }, { status: 403 }),
    );
    const outcome = await downloadOne(featuredTarget(ID_A));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('online-only');
    expect(readFeaturedCopies()).toEqual([]);
  });

  it('cartella con 8 brani e 5 già salvati: solo 3 richieste (il limite non si spreca)', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => String(index).repeat(22));
    register(...ids.slice(0, 5).map((id, index) => copy(`copia-${index}`, id)));
    mocks.fetch.mockResolvedValue(
      Response.json({ error: 'offline_not_allowed', message: 'No.' }, { status: 403 }),
    );
    const result = await runOfflineDownloadBatch(ids.map((id) => featuredTarget(id)));
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(result.already).toHaveLength(5);
    expect(result.stopped).toBeNull();
  });
});

describe('pulsante a icona «Scarica offline»', () => {
  it('mentre scarica: icona che gira, nome «Scarico …», annuncio subito', async () => {
    let finish: (response: Response) => void = () => undefined;
    mocks.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    const { container } = await mount(
      <SingleOfflineDownloadButton target={featuredTarget(ID_A)} signedIn iconOnly />,
    );
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Scarica Concessa per l’ascolto offline');
    await act(async () => button.click());
    await flush();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Scarico Concessa…');
    expect(button.getAttribute('title')).toBe('Scarico…');
    expect(button.querySelector('svg')?.getAttribute('class')).toContain(
      'motion-safe:animate-spin',
    );
    const live = container.querySelector('output[aria-live="polite"]');
    expect(live?.textContent).toBe('Scarico Concessa…');
    await act(async () =>
      finish(Response.json({ error: 'offline_not_allowed', message: 'No.' }, { status: 403 })),
    );
    await flush();
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(live?.textContent).toBe('');
  });

  it('copia già sul dispositivo: parte «Offline» e un tocco non scarica nulla', async () => {
    register(copy('copia-1', ID_A));
    const { container } = await mount(
      <SingleOfflineDownloadButton target={featuredTarget(ID_A)} signedIn iconOnly />,
    );
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe(
      'Concessa è nella tua Libreria per l’ascolto offline',
    );
    await act(async () => button.click());
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('elenco «solo streaming» di una cartella grande', () => {
  it('300 brani: frase breve come descrizione, motivo detto una volta, elenco chiuso', async () => {
    const tracks = [
      {
        id: 'Cartella/Ok.mp3',
        title: 'Ok',
        artist: 'Autrice',
        streamUrl: '/s',
        durationSeconds: 0,
        artworkUrl: null,
        artistSlug: null,
        shareId: ID_A,
        offline: true,
      },
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `Cartella/No ${index}.mp3`,
        title: `No ${index}`,
        artist: 'Autrice',
        streamUrl: '/s',
        durationSeconds: 0,
        artworkUrl: null,
        artistSlug: null,
        shareId: null,
        offline: false,
      })),
    ];
    const { container } = await mount(
      <FeaturedOfflineDownload
        tracks={tracks}
        label="Cartella"
        scope="questa cartella"
        actionLabel="Scarica la cartella per offline"
      />,
    );
    const button = container.querySelector('button[aria-describedby]') as HTMLButtonElement;
    const description = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent?.length).toBeLessThan(200);
    expect(description?.textContent).toContain('300 brani restano solo in streaming');
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Mostra i 300 brani');
    expect(details?.querySelectorAll('li')).toHaveLength(300);
    const reason =
      'Il titolare non ha concesso la copia offline: questo brano si ascolta solo in streaming.';
    expect(container.textContent?.split(reason).length).toBe(2);
  });
});

describe('verifica dei permessi in ogni pagina', () => {
  const revokedAnswer = () => Response.json({ permitted: [], revoked: [ID_A] });

  function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
  }

  beforeEach(() => {
    setOnline(true);
    register(copy('copia-1', ID_A));
    mocks.listTracks.mockResolvedValue([localTrack('copia-1')]);
  });

  it('errore di rete: copia tenuta, nuovo tentativo dopo qualche minuto, poi tolta con UN avviso', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockRejectedValueOnce(new TypeError('rete'));
    const stop = startFeaturedOfflineSync();
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.removeTrack).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValueOnce(revokedAnswer());
    await act(async () => vi.advanceTimersByTime(FEATURED_SYNC_RETRY_MS));
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.removeTrack).toHaveBeenCalledWith('copia-1');
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(String(mocks.toast.mock.calls[0]?.[0])).toContain('non è più disponibile offline');
    stop();
  });

  it('offline all’avvio: nulla; al ritorno online si verifica', async () => {
    setOnline(false);
    mocks.fetch.mockResolvedValue(Response.json({ permitted: [ID_A], revoked: [] }));
    const stop = startFeaturedOfflineSync();
    await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();
    setOnline(true);
    await act(async () => window.dispatchEvent(new Event('online')));
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('una verifica riuscita basta per un minuto; la scheda che torna visibile ricontrolla dopo 10', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));
    const stop = startFeaturedOfflineSync();
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Ritorno online subito dopo: nessuna nuova richiesta.
    await act(async () => window.dispatchEvent(new Event('online')));
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Scheda di nuovo visibile dopo 2 minuti: troppo presto per ricontrollare.
    await act(async () => vi.advanceTimersByTime(FEATURED_SYNC_MIN_INTERVAL_MS * 2));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Dopo 10 minuti sì.
    await act(async () => vi.advanceTimersByTime(FEATURED_SYNC_REVISIT_MS));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it('due verifiche avviate insieme (Libreria + mount): una richiesta, un solo avviso', async () => {
    mocks.fetch.mockImplementation(async () => revokedAnswer());
    function Probe() {
      useFeaturedOfflineSync();
      return null;
    }
    await mount(
      <>
        <Probe />
        <Probe />
      </>,
    );
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.removeTrack).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('smontata: niente più tentativi né ascoltatori', async () => {
    vi.useFakeTimers();
    mocks.fetch.mockRejectedValue(new TypeError('rete'));
    function Probe() {
      useFeaturedOfflineSync();
      return null;
    }
    const { root } = await mount(<Probe />);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => vi.advanceTimersByTime(FEATURED_SYNC_RETRY_MS * 2));
    await act(async () => window.dispatchEvent(new Event('online')));
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('mount globale: parte solo se c’è una copia (anche dopo un download nella scheda)', async () => {
    window.localStorage.clear();
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.listTracks).not.toHaveBeenCalled();
    // Un download registra una copia: la verifica parte.
    await act(async () => {
      rememberFeaturedCopy(copy('copia-1', ID_A));
    });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = mocks.fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/music/featured/offline-status');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ ids: [ID_A] });
  });
});
