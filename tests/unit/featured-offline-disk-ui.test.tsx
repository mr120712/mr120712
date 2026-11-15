// @polsia:user-owned — una copia offline di un "brano in evidenza" riconosciuta dal record della
// libreria sul dispositivo (fonte 'featured-download'), SENZA nessuna voce nel registro delle copie
// (localStorage vuoto, perso o illeggibile): il brano che va al player porta la sua fonte (quella
// che il player mostra) e i suoi crediti (campo `credits`, che il player oggi NON mostra: titolare
// e licenza si leggono nella riga della Libreria), mai «La tua musica» (quindi niente pannello
// "Testo"), mai «Audius» o «Podcast»; e il mount globale avvia la verifica dei permessi anche con
// il registro vuoto, se sul disco c'è una copia. Quel mount non riapre la libreria a ogni pagina
// per chi non ha copie (lo ricorda per un giorno), aspetta un momento libero, riprova da solo se
// la libreria non si legge, e fa uscire dal player le copie che la verifica toglie.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  listTracks: vi.fn(),
  removeTrack: vi.fn(),
  repairSources: vi.fn(),
  hasDownloadedTrack: vi.fn(),
  forgetLocalTracks: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => true }));
vi.mock('@/lib/local-music', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/local-music')>()),
  listTracks: mocks.listTracks,
  removeTrack: mocks.removeTrack,
  repairFeaturedCopySources: mocks.repairSources,
}));
vi.mock('@/lib/local-music/reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/local-music/reader')>()),
  hasDownloadedTrack: mocks.hasDownloadedTrack,
}));
// Il player condiviso: al mount serve solo forgetLocalTracks (le copie tolte escono dalla coda).
vi.mock('@/components/custom/music/music-player', () => ({
  useOptionalMusicPlayer: () => ({ forgetLocalTracks: mocks.forgetLocalTracks }),
  useMusicPlayer: () => null,
}));

import {
  announceFeaturedCopiesRemoved,
  emptyDiskLookIsFresh,
  FEATURED_OFFLINE_COPIES_KEY,
  FEATURED_OFFLINE_COPIES_REMOVED_EVENT,
  FEATURED_OFFLINE_DISK_LOOK_KEY,
  FEATURED_OFFLINE_DISK_LOOK_TTL_MS,
  type FeaturedOfflineCopy,
  readFeaturedCopies,
  rememberEmptyDiskLook,
  rememberFeaturedCopy,
} from '@/components/custom/music/featured-offline-copies';
import {
  resetFeaturedSyncForTests,
  syncFeaturedOfflineCopies,
} from '@/components/custom/music/featured-offline-sync';
import {
  FEATURED_DISK_LOOK_DELAY_MS,
  FEATURED_DISK_LOOK_IDLE_TIMEOUT_MS,
  FEATURED_DISK_LOOK_RETRY_MS,
  FeaturedOfflineSyncMount,
} from '@/components/custom/music/featured-offline-sync-mount';
import { localTrackForPlayer } from '@/components/custom/music/local-music-section';
import {
  FEATURED_COPY_SOURCE_LABEL,
  featuredCopyAttribution,
  LOCAL_SOURCE_LABEL,
  localTrackKind,
  localTrackToPlayerTrack,
  persistedQueueItem,
  restoreLocalItems,
} from '@/components/custom/music/local-tracks';
import { lyricsTargetFor } from '@/components/custom/music/lyrics-target';
import type { LocalTrack } from '@/lib/local-music';

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';

const attribution = {
  sourceName: 'Solco · In evidenza',
  sourceUrl: null,
  licenseName: 'Creative Commons Attribuzione (CC BY)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
  creditLine: '© Banda di prova',
};

function ownFile(id: string): LocalTrack {
  return {
    id,
    title: `Brano ${id}`,
    artist: 'Autrice',
    album: null,
    durationSeconds: 200,
    mimeType: 'audio/mpeg',
    size: 1000,
    addedAt: 1,
    hasArtwork: false,
  };
}

/** Una copia come la rilegge la libreria dal disco: fonte, chiave e attribuzione nel record. */
function copyOnDisk(id: string, extra: Partial<LocalTrack> = {}): LocalTrack {
  return {
    ...ownFile(id),
    source: 'featured-download',
    downloadKey: `featured:${ID_A}`,
    attribution,
    ...extra,
  };
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
  return root;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', mocks.fetch);
  // Il mount guarda nella libreria «quando il browser è libero»: nei test, al primo microtask.
  vi.stubGlobal('requestIdleCallback', (run: () => void) => {
    queueMicrotask(run);
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => undefined);
  window.localStorage.clear();
  for (const mock of [
    mocks.fetch,
    mocks.listTracks,
    mocks.removeTrack,
    mocks.repairSources,
    mocks.hasDownloadedTrack,
    mocks.forgetLocalTracks,
    mocks.toast,
  ]) {
    mock.mockReset();
  }
  mocks.listTracks.mockResolvedValue([]);
  mocks.removeTrack.mockResolvedValue(undefined);
  mocks.repairSources.mockResolvedValue(0);
  mocks.hasDownloadedTrack.mockResolvedValue(false);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  resetFeaturedSyncForTests();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('copia riconosciuta dal disco, senza voce nel registro', () => {
  it('brano per il player: la sua fonte e i suoi crediti (campo credits), mai «La tua musica», niente "Testo"', () => {
    expect(readFeaturedCopies()).toEqual([]);
    const item = localTrackToPlayerTrack(copyOnDisk('copia-1'));
    expect(item).toMatchObject({
      qualifiedId: 'local:copia-1',
      playbackMode: 'local',
      sourceLabel: 'Solco · In evidenza',
      sourceUrl: null,
      credits: ['© Banda di prova', 'Licenza: Creative Commons Attribuzione (CC BY)'],
    });
    expect(item.sourceLabel).not.toBe(LOCAL_SOURCE_LABEL);
    expect(item.sourceUrlLabel).toBeUndefined();
    expect(lyricsTargetFor(item)).toBeNull();
  });

  it('mai «Audius» o «Podcast», nemmeno senza attribuzione nel record', () => {
    for (const extra of [{ attribution: null }, { attribution: undefined }]) {
      const item = localTrackToPlayerTrack(copyOnDisk('copia-1', extra));
      expect(item.sourceLabel).toBe(FEATURED_COPY_SOURCE_LABEL);
      expect(item.credits).toBeUndefined();
      expect(item.sourceUrl).toBeNull();
      expect(item.sourceUrlLabel).toBeUndefined();
      expect(lyricsTargetFor(item)).toBeNull();
    }
  });

  it('un’attribuzione che dicesse «La tua musica» non accende il pannello "Testo"', () => {
    const item = localTrackToPlayerTrack(
      copyOnDisk('copia-1', { attribution: { ...attribution, sourceName: LOCAL_SOURCE_LABEL } }),
    );
    expect(item.sourceLabel).toBe(FEATURED_COPY_SOURCE_LABEL);
    expect(lyricsTargetFor(item)).toBeNull();
  });

  it('coda ripristinata (salvata con il solo id): torna con la fonte della copia, niente "Testo"', async () => {
    const saved = persistedQueueItem(localTrackToPlayerTrack(copyOnDisk('copia-1')));
    // La coda salvata non dice che cos'è il brano: lo dice il record riletto dal dispositivo.
    expect(saved.sourceLabel).toBe(LOCAL_SOURCE_LABEL);
    const restored = await restoreLocalItems([saved], 0, async (id) => copyOnDisk(id));
    expect(restored?.items[0]).toMatchObject({
      qualifiedId: 'local:copia-1',
      sourceLabel: 'Solco · In evidenza',
      credits: ['© Banda di prova', 'Licenza: Creative Commons Attribuzione (CC BY)'],
    });
    expect(lyricsTargetFor(restored?.items[0] ?? null)).toBeNull();
  });

  it('dalla Libreria (localTrackForPlayer): uguale, e l’attribuzione del record vince sul registro', () => {
    const track = copyOnDisk('copia-1');
    expect(localTrackForPlayer(track, null)).toEqual(localTrackToPlayerTrack(track));
    const staleEntry: FeaturedOfflineCopy = {
      localId: 'copia-1',
      featuredId: ID_A,
      attribution: { ...attribution, creditLine: '© Voce vecchia' },
      savedAt: 1,
    };
    expect(localTrackForPlayer(track, staleEntry).credits).toEqual([
      '© Banda di prova',
      'Licenza: Creative Commons Attribuzione (CC BY)',
    ]);
    expect(featuredCopyAttribution(track, staleEntry)).toEqual(attribution);
    // Senza attribuzione nel record resta quella del registro.
    expect(featuredCopyAttribution({ attribution: null }, staleEntry)?.creditLine).toBe(
      '© Voce vecchia',
    );
  });

  it('localTrackKind: copia se lo dice il disco o il registro; gli altri brani non cambiano', () => {
    const entry: FeaturedOfflineCopy = {
      localId: 'x',
      featuredId: ID_A,
      attribution: null,
      savedAt: 1,
    };
    expect(localTrackKind(copyOnDisk('x'), null)).toBe('featured-download');
    expect(localTrackKind(ownFile('x'), entry)).toBe('featured-download');
    expect(localTrackKind(ownFile('x'), null)).toBe('local');
    expect(localTrackKind({ source: 'audius-download' }, null)).toBe('audius-download');
    expect(localTrackKind({ source: 'podcast-download' }, undefined)).toBe('podcast-download');

    // Un file dell'ascoltatore e i download Audius/podcast restano come prima.
    const mine = localTrackToPlayerTrack(ownFile('mio-file'));
    expect(mine.sourceLabel).toBe(LOCAL_SOURCE_LABEL);
    expect(lyricsTargetFor(mine)).toEqual({ source: 'local', id: 'mio-file' });
    expect(
      localTrackToPlayerTrack({ ...ownFile('a'), source: 'audius-download', attribution: null })
        .sourceLabel,
    ).toBe('Audius');
    expect(
      localTrackToPlayerTrack({ ...ownFile('p'), source: 'podcast-download', attribution: null })
        .sourceLabel,
    ).toBe('Podcast');
  });
});

describe('mount globale: la verifica parte anche con il registro vuoto, se sul disco c’è una copia', () => {
  it('registro vuoto + copia sul disco: verifica avviata, voce ricostruita, copia revocata tolta', async () => {
    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1'), ownFile('mio-file')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [], revoked: [ID_A] }));

    await mount(<FeaturedOfflineSyncMount />);
    await vi.waitFor(() => expect(mocks.removeTrack).toHaveBeenCalledWith('copia-1'));

    expect(mocks.hasDownloadedTrack).toHaveBeenCalledWith('featured-download');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/music/featured/offline-status');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ ids: [ID_A] });
    expect(mocks.removeTrack).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('copia ancora consentita: resta sul dispositivo e la sua voce torna nel registro', async () => {
    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));

    await mount(<FeaturedOfflineSyncMount />);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await flush();

    expect(mocks.removeTrack).not.toHaveBeenCalled();
    expect(mocks.forgetLocalTracks).not.toHaveBeenCalled();
    expect(readFeaturedCopies()).toEqual([
      { localId: 'copia-1', featuredId: ID_A, attribution, savedAt: 1 },
    ]);
    // Una copia c'è: nessun promemoria «sul disco non c'è nessuna copia».
    expect(window.localStorage.getItem(FEATURED_OFFLINE_DISK_LOOK_KEY)).toBeNull();
  });

  it('registro illeggibile + copia sul disco: la verifica parte lo stesso', async () => {
    window.localStorage.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"copies": [ rovinato');
    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));

    await mount(<FeaturedOfflineSyncMount />);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await flush();
    expect(mocks.removeTrack).not.toHaveBeenCalled();
    // Il registro illeggibile non si sovrascrive.
    expect(window.localStorage.getItem(FEATURED_OFFLINE_COPIES_KEY)).toBe('{"copies": [ rovinato');
  });

  it('nessuna copia né nel registro né sul disco: niente verifica, e si guarda una volta sola', async () => {
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    await act(async () => window.dispatchEvent(new Event('online')));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
    expect(mocks.listTracks).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('libreria illeggibile adesso: si riprova al prossimo evento', async () => {
    mocks.hasDownloadedTrack.mockRejectedValueOnce(new Error('idb'));
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();
    // Una lettura non riuscita non è un «nessuna copia»: niente promemoria.
    expect(window.localStorage.getItem(FEATURED_OFFLINE_DISK_LOOK_KEY)).toBeNull();

    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));
    await act(async () => window.dispatchEvent(new Event('online')));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(2);
  });

  it('libreria illeggibile adesso: si riprova anche quando la scheda torna visibile', async () => {
    mocks.hasDownloadedTrack.mockRejectedValueOnce(new Error('idb'));
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);

    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(2);
  });

  it('libreria illeggibile adesso: si riprova DA SOLI dopo qualche minuto, senza nessun evento', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.hasDownloadedTrack.mockRejectedValueOnce(new Error('idb'));
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);

    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [], revoked: [ID_A] }));
    // Poco prima del tempo: ancora nulla.
    await act(async () => vi.advanceTimersByTime(FEATURED_DISK_LOOK_RETRY_MS - 1));
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(2);
    // La copia c'era, ed era revocata: la verifica parte e la toglie.
    vi.useRealTimers();
    await vi.waitFor(() => expect(mocks.removeTrack).toHaveBeenCalledWith('copia-1'));
  });

  it('smontato prima della risposta del disco: non parte nulla', async () => {
    let answer: (found: boolean) => void = () => undefined;
    mocks.hasDownloadedTrack.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    const root = await mount(<FeaturedOfflineSyncMount />);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => answer(true));
    await flush();
    expect(mocks.listTracks).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('mount globale: chi non ha copie non paga una lettura della libreria a ogni pagina', () => {
  async function unmount(root: ReturnType<typeof createRoot>) {
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
  }

  it('nessuna copia: lo ricorda, e le pagine dopo non riaprono la libreria', async () => {
    // Prima pagina: si guarda, non c'è nulla, resta il promemoria.
    const first = await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
    expect(emptyDiskLookIsFresh()).toBe(true);
    await unmount(first);

    // Altre tre pagine (ogni caricamento rimonta il mount): nessuna nuova lettura.
    for (let page = 0; page < 3; page += 1) {
      const next = await mount(<FeaturedOfflineSyncMount />);
      await flush();
      await act(async () => window.dispatchEvent(new Event('online')));
      await flush();
      await unmount(next);
    }
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
    expect(mocks.listTracks).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('il promemoria vale un giorno: poi si guarda di nuovo', async () => {
    const now = Date.now();
    rememberEmptyDiskLook(now - FEATURED_OFFLINE_DISK_LOOK_TTL_MS + 60_000);
    const fresh = await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).not.toHaveBeenCalled();
    await unmount(fresh);

    rememberEmptyDiskLook(now - FEATURED_OFFLINE_DISK_LOOK_TTL_MS - 1);
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
  });

  it('promemoria rovinato o con una data nel futuro: nel dubbio si guarda', async () => {
    for (const value of ['non un numero', '', String(Date.now() + 3_600_000), '-5']) {
      window.localStorage.setItem(FEATURED_OFFLINE_DISK_LOOK_KEY, value);
      expect(emptyDiskLookIsFresh(), value).toBe(false);
    }
    expect(emptyDiskLookIsFresh(Date.now(), null)).toBe(false);
    window.localStorage.setItem(FEATURED_OFFLINE_DISK_LOOK_KEY, String(Date.now() + 3_600_000));
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
  });

  it('una copia salvata toglie il promemoria: se poi il registro perde la voce, la copia si ritrova', async () => {
    rememberEmptyDiskLook();
    expect(emptyDiskLookIsFresh()).toBe(true);
    // «Scarica offline» registra la copia: «nessuna copia» non vale più.
    expect(
      rememberFeaturedCopy({ localId: 'copia-1', featuredId: ID_A, attribution, savedAt: 1 }),
    ).toBe(true);
    expect(emptyDiskLookIsFresh()).toBe(false);
    // Il registro perde la voce; il file resta in IndexedDB.
    window.localStorage.removeItem(FEATURED_OFFLINE_COPIES_KEY);

    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [], revoked: [ID_A] }));
    await mount(<FeaturedOfflineSyncMount />);
    await vi.waitFor(() => expect(mocks.removeTrack).toHaveBeenCalledWith('copia-1'));
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
  });

  it('una copia salvata mentre la lettura è in corso: nessun promemoria «nessuna copia»', async () => {
    let answer: (found: boolean) => void = () => undefined;
    mocks.hasDownloadedTrack.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);

    // «Scarica offline» salva e registra una copia; la lettura, cominciata prima, non la vede.
    await act(async () => {
      rememberFeaturedCopy({ localId: 'copia-1', featuredId: ID_A, attribution, savedAt: 1 });
    });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await act(async () => answer(false));
    await flush();
    expect(window.localStorage.getItem(FEATURED_OFFLINE_DISK_LOOK_KEY)).toBeNull();
  });

  it('registro illeggibile: il promemoria non vale (non si sa che cosa conteneva)', async () => {
    rememberEmptyDiskLook();
    window.localStorage.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"copies": [ rovinato');
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
  });

  it('la lettura aspetta un momento libero: mai al montaggio, e si annulla allo smontaggio', async () => {
    const idle: Array<() => void> = [];
    const request = vi.fn((run: () => void, _options?: { timeout?: number }) => {
      idle.push(run);
      return 42;
    });
    const cancel = vi.fn();
    vi.stubGlobal('requestIdleCallback', request);
    vi.stubGlobal('cancelIdleCallback', cancel);

    const root = await mount(<FeaturedOfflineSyncMount />);
    await flush();
    // Montato (e idratato): la libreria non è ancora stata aperta.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toEqual({ timeout: FEATURED_DISK_LOOK_IDLE_TIMEOUT_MS });
    expect(mocks.hasDownloadedTrack).not.toHaveBeenCalled();
    // Un evento nel frattempo non mette in coda una seconda lettura.
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => idle[0]?.());
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);

    // Un altro mount smontato prima del momento libero: la lettura è annullata e non parte.
    window.localStorage.clear();
    await unmount(root);
    const second = await mount(<FeaturedOfflineSyncMount />);
    expect(request).toHaveBeenCalledTimes(2);
    await unmount(second);
    expect(cancel).toHaveBeenCalledWith(42);
    await act(async () => idle[1]?.());
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
  });

  it('senza requestIdleCallback (Safari): dopo una breve attesa, non subito', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.hasDownloadedTrack).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(FEATURED_DISK_LOOK_DELAY_MS - 1));
    await flush();
    expect(mocks.hasDownloadedTrack).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    await flush();
    expect(mocks.hasDownloadedTrack).toHaveBeenCalledTimes(1);
  });

  it('con una voce nel registro non si guarda nel disco: la verifica parte subito', async () => {
    rememberFeaturedCopy({ localId: 'copia-1', featuredId: ID_A, attribution, savedAt: 1 });
    mocks.listTracks.mockResolvedValue([copyOnDisk('copia-1')]);
    mocks.fetch.mockImplementation(async () => Response.json({ permitted: [ID_A], revoked: [] }));
    await mount(<FeaturedOfflineSyncMount />);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(mocks.hasDownloadedTrack).not.toHaveBeenCalled();
  });
});

describe('voce del registro su un file dell’ascoltatore: la verifica la dimentica e il file torna suo', () => {
  it('il file resta sul dispositivo; dopo la verifica ha di nuovo la sua fonte e il pannello "Testo"', async () => {
    // Registro rovinato o manomesso: indica come copia un file dell'ascoltatore.
    rememberFeaturedCopy({ localId: 'mio-file', featuredId: ID_A, attribution, savedAt: 1 });
    const mine = ownFile('mio-file');
    // Finché la voce c'è l'interfaccia resta prudente: lo tratta come una copia.
    expect(localTrackToPlayerTrack(mine).sourceLabel).toBe('Solco · In evidenza');
    expect(lyricsTargetFor(localTrackToPlayerTrack(mine))).toBeNull();

    const changed = vi.fn();
    window.addEventListener('solco:local-music-changed', changed);
    const fetcher = vi.fn(async () => Response.json({ permitted: [], revoked: [ID_A] }));
    const result = await syncFeaturedOfflineCopies({
      fetcher: fetcher as unknown as typeof fetch,
      listTracks: async () => [mine],
      removeTrack: mocks.removeTrack,
    });
    window.removeEventListener('solco:local-music-changed', changed);

    // Nulla da verificare e nulla da togliere: il server non viene nemmeno interpellato.
    expect(result).toEqual({ status: 'skipped', removed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.removeTrack).not.toHaveBeenCalled();
    expect(mocks.forgetLocalTracks).not.toHaveBeenCalled();
    expect(readFeaturedCopies()).toEqual([]);
    // «La tua musica» e i pulsanti rileggono: il file è di nuovo un file dell'ascoltatore.
    expect(changed).toHaveBeenCalledTimes(1);
    const item = localTrackToPlayerTrack(mine);
    expect(item.sourceLabel).toBe(LOCAL_SOURCE_LABEL);
    expect(lyricsTargetFor(item)).toEqual({ source: 'local', id: 'mio-file' });
  });

  it('voce di una copia tolta a mano (il brano non c’è più): dimenticata senza disturbare l’interfaccia', async () => {
    rememberFeaturedCopy({ localId: 'copia-1', featuredId: ID_A, attribution, savedAt: 1 });
    const changed = vi.fn();
    window.addEventListener('solco:local-music-changed', changed);
    const result = await syncFeaturedOfflineCopies({
      fetcher: vi.fn() as unknown as typeof fetch,
      listTracks: async () => [ownFile('mio-file')],
      removeTrack: mocks.removeTrack,
    });
    window.removeEventListener('solco:local-music-changed', changed);
    expect(result).toEqual({ status: 'skipped', removed: 0 });
    expect(readFeaturedCopies()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('una copia tolta dalla verifica esce anche dal player', () => {
  it('revocata: il player la dimentica (coda, brano in corso, file in memoria)', async () => {
    mocks.hasDownloadedTrack.mockResolvedValue(true);
    mocks.listTracks.mockResolvedValue([
      copyOnDisk('copia-1'),
      copyOnDisk('copia-2', { downloadKey: `featured:${ID_B}` }),
      ownFile('mio-file'),
    ]);
    mocks.fetch.mockImplementation(async () =>
      Response.json({ permitted: [ID_B], revoked: [ID_A] }),
    );

    await mount(<FeaturedOfflineSyncMount />);
    await vi.waitFor(() => expect(mocks.forgetLocalTracks).toHaveBeenCalledTimes(1));

    // Solo la copia revocata: quella ancora consentita e il file dell'ascoltatore restano.
    expect(mocks.forgetLocalTracks).toHaveBeenCalledWith(['copia-1']);
    expect(mocks.removeTrack).toHaveBeenCalledTimes(1);
    expect(mocks.removeTrack).toHaveBeenCalledWith('copia-1');
  });

  it('vale anche se la verifica è partita altrove (la Libreria) e non dal mount', async () => {
    // Nessuna copia nota al mount: non avvia nessuna verifica, ma ascolta.
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    expect(mocks.fetch).not.toHaveBeenCalled();

    const result = await syncFeaturedOfflineCopies({
      fetcher: (async () =>
        Response.json({ permitted: [], revoked: [ID_A] })) as unknown as typeof fetch,
      listTracks: async () => [copyOnDisk('copia-1')],
      removeTrack: mocks.removeTrack,
    });
    expect(result).toEqual({ status: 'ok', removed: 1 });
    expect(mocks.forgetLocalTracks).toHaveBeenCalledTimes(1);
    expect(mocks.forgetLocalTracks).toHaveBeenCalledWith(['copia-1']);
  });

  it('una copia non verificabile tolta senza chiedere al server esce dal player allo stesso modo', async () => {
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    const fetcher = vi.fn();
    const result = await syncFeaturedOfflineCopies({
      fetcher: fetcher as unknown as typeof fetch,
      listTracks: async () => [copyOnDisk('copia-9', { downloadKey: 'featured:non-valida' })],
      removeTrack: mocks.removeTrack,
    });
    expect(result).toEqual({ status: 'ok', removed: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.forgetLocalTracks).toHaveBeenCalledWith(['copia-9']);
  });

  it('rimozione non riuscita o copia ancora consentita: il player non viene toccato', async () => {
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    // Consentita.
    await syncFeaturedOfflineCopies({
      fetcher: (async () =>
        Response.json({ permitted: [ID_A], revoked: [] })) as unknown as typeof fetch,
      listTracks: async () => [copyOnDisk('copia-1')],
      removeTrack: mocks.removeTrack,
    });
    // Revocata, ma il file non si riesce a togliere: resta sul dispositivo e nel player.
    const result = await syncFeaturedOfflineCopies({
      fetcher: (async () =>
        Response.json({ permitted: [], revoked: [ID_A] })) as unknown as typeof fetch,
      listTracks: async () => [copyOnDisk('copia-1')],
      removeTrack: async () => {
        throw new Error('idb');
      },
    });
    expect(result).toEqual({ status: 'retry', removed: 0 });
    expect(mocks.forgetLocalTracks).not.toHaveBeenCalled();
  });

  it('l’evento porta solo id della libreria: un evento vuoto o malformato non tocca il player', async () => {
    await mount(<FeaturedOfflineSyncMount />);
    await flush();
    const heard = vi.fn();
    window.addEventListener(FEATURED_OFFLINE_COPIES_REMOVED_EVENT, heard);
    // Nessuna copia tolta: nessun evento.
    announceFeaturedCopiesRemoved([]);
    expect(heard).not.toHaveBeenCalled();
    for (const detail of [undefined, null, {}, { localIds: 'copia-1' }, { localIds: [1, null] }]) {
      window.dispatchEvent(new CustomEvent(FEATURED_OFFLINE_COPIES_REMOVED_EVENT, { detail }));
    }
    expect(mocks.forgetLocalTracks).not.toHaveBeenCalled();
    // Ben formato: arrivano gli id, e solo le stringhe.
    window.dispatchEvent(
      new CustomEvent(FEATURED_OFFLINE_COPIES_REMOVED_EVENT, {
        detail: { localIds: ['copia-1', 7, 'copia-2'] },
      }),
    );
    window.removeEventListener(FEATURED_OFFLINE_COPIES_REMOVED_EVENT, heard);
    expect(mocks.forgetLocalTracks).toHaveBeenCalledTimes(1);
    expect(mocks.forgetLocalTracks).toHaveBeenCalledWith(['copia-1', 'copia-2']);
  });

  it('mount smontato: nessun ascoltatore resta', async () => {
    const root = await mount(<FeaturedOfflineSyncMount />);
    await flush();
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await syncFeaturedOfflineCopies({
      fetcher: (async () =>
        Response.json({ permitted: [], revoked: [ID_A] })) as unknown as typeof fetch,
      listTracks: async () => [copyOnDisk('copia-1')],
      removeTrack: mocks.removeTrack,
    });
    expect(mocks.removeTrack).toHaveBeenCalledWith('copia-1');
    expect(mocks.forgetLocalTracks).not.toHaveBeenCalled();
  });
});
