// @polsia:user-owned — verifica delle copie offline dei "brani in evidenza" con la libreria sul
// dispositivo (IndexedDB) come fonte di verità. Una copia sul disco SENZA voce nel registro
// (registro perso, svuotato o illeggibile) non si toglie e non resta senza controllo: la voce si
// ricostruisce dal disco (id dalla chiave del download, attribuzione dal record) e la copia si
// verifica come le altre, quindi si toglie SOLO se il server la dichiara revocata. Senza risposta
// del server si toglie solo una copia con la chiave malformata (non verificabile in nessun modo),
// e mai se il registro non si è potuto leggere o scrivere. Restano le garanzie di prima: errore di
// rete, 503 o risposta non valida tengono tutto; lotti di al massimo 100; al server solo gli id.
// In più: SOLO il disco decide che cosa si può togliere (una voce del registro su un file
// dell'ascoltatore si dimentica, e il file resta qualunque cosa dica il server); una verifica vale
// come riuscita solo se ogni copia revocata è stata davvero tolta e se la libreria si è potuta
// leggere; e la fonte persa dai record più vecchi torna anche sul disco.
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import {
  type CopyStorage,
  emptyDiskLookIsFresh,
  FEATURED_OFFLINE_COPIES_KEY,
  type FeaturedOfflineCopy,
  readFeaturedCopies,
  readFeaturedCopyRegistry,
  rememberEmptyDiskLook,
  rememberFeaturedCopies,
  rememberFeaturedCopy,
} from '@/components/custom/music/featured-offline-copies';
import {
  resetFeaturedSyncForTests,
  runFeaturedOfflineSync,
  syncFeaturedOfflineCopies,
} from '@/components/custom/music/featured-offline-sync';
import type { LocalMusicDb, LocalMusicStoreName, LocalMusicWrite } from '@/lib/local-music/idb';
import { createLocalMusicStore } from '@/lib/local-music/store';
import { emptyTags, type LocalTrack } from '@/lib/local-music/types';

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const ID_C = 'CCCCCCCCCCCCCCCCCCCCCC';

const attribution = {
  sourceName: 'Solco · In evidenza',
  sourceUrl: null,
  licenseName: 'Creative Commons Attribuzione (CC BY)',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
  creditLine: '© Banda di prova',
};

function memoryStorage(): CopyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** localStorage che si legge ma non si scrive (spazio esaurito, modalità privata). */
function readOnlyStorage(): CopyStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => undefined,
  };
}

/** localStorage negato: ogni accesso lancia. */
function deniedStorage(): CopyStorage {
  const denied = () => {
    throw new Error('SecurityError');
  };
  return { getItem: denied, setItem: denied, removeItem: denied };
}

function ownFile(id: string, title = `Mio ${id}`): LocalTrack {
  return {
    id,
    title,
    artist: null,
    album: null,
    durationSeconds: 100,
    mimeType: 'audio/mpeg',
    size: 3,
    addedAt: 1,
    hasArtwork: false,
  };
}

/** Una copia come la rilegge la libreria: fonte, chiave del download e attribuzione dal record. */
function copyOnDisk(id: string, shareId: string, extra: Partial<LocalTrack> = {}): LocalTrack {
  return {
    ...ownFile(id, `Copia ${id}`),
    addedAt: 777,
    source: 'featured-download',
    downloadKey: `featured:${shareId}`,
    attribution,
    ...extra,
  };
}

function library(initial: LocalTrack[]) {
  let tracks = [...initial];
  const removeTrack = vi.fn(async (id: string) => {
    tracks = tracks.filter((track) => track.id !== id);
  });
  const listTracks = vi.fn(async () => [...tracks]);
  return { listTracks, removeTrack, ids: () => tracks.map((track) => track.id) };
}

function answer(body: { permitted?: string[]; revoked?: string[] }) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ permitted: body.permitted ?? [], revoked: body.revoked ?? [] }),
  );
}

/** Il corpo di ogni richiesta fatta al server (una per lotto). */
function sentBodies(fetcher: ReturnType<typeof answer>): string[] {
  return fetcher.mock.calls.map(([, init]) => String(init?.body));
}

function sentIds(fetcher: ReturnType<typeof answer>): string[][] {
  return sentBodies(fetcher).map((body) => (JSON.parse(body) as { ids: string[] }).ids);
}

afterEach(() => {
  resetFeaturedSyncForTests();
  vi.unstubAllGlobals();
});

describe('copia sul disco senza voce nel registro: ricostruita e verificata', () => {
  it('registro vuoto: la voce si ricostruisce dal disco e la copia consentita resta', async () => {
    const storage = memoryStorage();
    const lib = library([copyOnDisk('l1', ID_A), ownFile('mio-1')]);
    const fetcher = answer({ permitted: [ID_A] });

    const result = await syncFeaturedOfflineCopies({ fetcher, storage, ...lib });

    expect(result).toEqual({ status: 'ok', removed: 0 });
    expect(lib.removeTrack).not.toHaveBeenCalled();
    expect(lib.ids()).toEqual(['l1', 'mio-1']);
    // Voce ricostruita: id dalla chiave del download, attribuzione e data dal record.
    expect(readFeaturedCopies(storage)).toEqual([
      { localId: 'l1', featuredId: ID_A, attribution, savedAt: 777 },
    ]);
    // Al server solo l'id opaco della copia: niente del file dell'ascoltatore.
    expect(sentIds(fetcher)).toEqual([[ID_A]]);
    const [body] = sentBodies(fetcher);
    expect(body).not.toContain('mio-1');
    expect(body).not.toContain('Copia');
  });

  it('…e si toglie SOLO quando il server la dichiara revocata', async () => {
    const storage = memoryStorage();
    const lib = library([copyOnDisk('l1', ID_A), copyOnDisk('l2', ID_B), ownFile('mio-1')]);

    // Prima verifica: consentite. Nulla si toglie, due voci ricostruite.
    expect(
      await syncFeaturedOfflineCopies({
        fetcher: answer({ permitted: [ID_A, ID_B] }),
        storage,
        ...lib,
      }),
    ).toEqual({ status: 'ok', removed: 0 });
    expect(lib.ids()).toEqual(['l1', 'l2', 'mio-1']);
    expect(readFeaturedCopies(storage).map((copy) => copy.localId)).toEqual(['l1', 'l2']);

    // Il titolare revoca il secondo brano: via quella copia (e la sua voce), il resto resta.
    const fetcher = answer({ permitted: [ID_A], revoked: [ID_B] });
    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'ok',
      removed: 1,
    });
    expect(lib.removeTrack).toHaveBeenCalledTimes(1);
    expect(lib.removeTrack).toHaveBeenCalledWith('l2');
    expect(lib.ids()).toEqual(['l1', 'mio-1']);
    expect(readFeaturedCopies(storage).map((copy) => copy.localId)).toEqual(['l1']);
  });

  it('errore di rete, 503 o risposta non valida: la copia senza voce RESTA (e la voce è ricostruita)', async () => {
    for (const fetcher of [
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 503 })),
      vi.fn(async () => Response.json({ tutto: 'revocato' })),
      vi.fn(async () => new Response('<html>errore</html>', { status: 200 })),
    ]) {
      const storage = memoryStorage();
      const lib = library([copyOnDisk('l1', ID_A)]);
      const result = await syncFeaturedOfflineCopies({
        fetcher: fetcher as unknown as typeof fetch,
        storage,
        ...lib,
      });
      expect(result).toEqual({ status: 'retry', removed: 0 });
      expect(lib.removeTrack).not.toHaveBeenCalled();
      expect(readFeaturedCopies(storage).map((copy) => copy.featuredId)).toEqual([ID_A]);
    }
  });

  it('un id non elencato dal server (né consentito né revocato) resta com’è', async () => {
    const storage = memoryStorage();
    const lib = library([copyOnDisk('l1', ID_A)]);
    expect(await syncFeaturedOfflineCopies({ fetcher: answer({}), storage, ...lib })).toEqual({
      status: 'ok',
      removed: 0,
    });
    expect(lib.removeTrack).not.toHaveBeenCalled();
  });

  it('il disco vince sul registro: una voce con un altro id si corregge e si verifica l’id del disco', async () => {
    const storage = memoryStorage();
    rememberFeaturedCopy(
      { localId: 'l1', featuredId: ID_C, attribution: null, savedAt: 5 },
      storage,
    );
    const lib = library([copyOnDisk('l1', ID_A)]);
    const fetcher = answer({ permitted: [ID_A], revoked: [ID_C] });

    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'ok',
      removed: 0,
    });
    expect(sentIds(fetcher)).toEqual([[ID_A]]);
    expect(lib.removeTrack).not.toHaveBeenCalled();
    expect(readFeaturedCopies(storage)).toEqual([
      { localId: 'l1', featuredId: ID_A, attribution, savedAt: 5 },
    ]);
  });

  it('a lotti di al massimo 100 id, anche quando gli id vengono tutti dal disco', async () => {
    const storage = memoryStorage();
    const copies = Array.from({ length: 150 }, (_, index) =>
      copyOnDisk(`l${index}`, `${String(index).padStart(3, '0')}${'X'.repeat(19)}`),
    );
    const lib = library(copies);
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
      expect(ids.length).toBeLessThanOrEqual(100);
      return Response.json({ permitted: ids, revoked: [] });
    });
    const result = await syncFeaturedOfflineCopies({
      fetcher: fetcher as unknown as typeof fetch,
      storage,
      ...lib,
    });
    expect(result).toEqual({ status: 'ok', removed: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readFeaturedCopies(storage)).toHaveLength(150);
  });

  it('un file dell’ascoltatore non entra mai nella verifica, nemmeno con un nome che imita una copia', async () => {
    const storage = memoryStorage();
    const lib = library([ownFile('mio-1', `featured:${ID_A}`), ownFile('mio-2', 'download')]);
    const fetcher = answer({ revoked: [ID_A] });
    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'skipped',
      removed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(lib.removeTrack).not.toHaveBeenCalled();
    expect(readFeaturedCopies(storage)).toEqual([]);
  });
});

describe('chiave del download malformata', () => {
  const broken = (id: string, extra: Partial<LocalTrack> = {}) =>
    copyOnDisk(id, ID_A, { downloadKey: 'featured:non-valida', ...extra });

  it('nessun id sul disco e nessuna voce in un registro che funziona: si toglie senza chiedere al server', async () => {
    const storage = memoryStorage();
    const withoutKey = copyOnDisk('l2', ID_A);
    delete withoutKey.downloadKey;
    const lib = library([broken('l1'), withoutKey, ownFile('mio-1')]);
    const fetcher = answer({ permitted: [ID_A] });

    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'ok',
      removed: 2,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(lib.ids()).toEqual(['mio-1']);
  });

  it('con una voce nel registro si verifica con quell’id (e resta, se consentita)', async () => {
    const storage = memoryStorage();
    rememberFeaturedCopy({ localId: 'l1', featuredId: ID_B, attribution, savedAt: 1 }, storage);
    const lib = library([broken('l1')]);
    const fetcher = answer({ permitted: [ID_B] });

    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'ok',
      removed: 0,
    });
    expect(sentIds(fetcher)).toEqual([[ID_B]]);
    expect(lib.removeTrack).not.toHaveBeenCalled();

    // Revocata: si toglie perché lo dice il server.
    expect(
      await syncFeaturedOfflineCopies({ fetcher: answer({ revoked: [ID_B] }), storage, ...lib }),
    ).toEqual({ status: 'ok', removed: 1 });
    expect(lib.ids()).toEqual([]);
  });

  it('le copie con la chiave giusta non ne risentono', async () => {
    const storage = memoryStorage();
    const lib = library([broken('l1'), copyOnDisk('l2', ID_B)]);
    const fetcher = answer({ permitted: [ID_B] });
    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'ok',
      removed: 1,
    });
    expect(lib.removeTrack).toHaveBeenCalledWith('l1');
    expect(lib.ids()).toEqual(['l2']);
    expect(sentIds(fetcher)).toEqual([[ID_B]]);
  });
});

describe('registro non disponibile (localStorage assente, negato, pieno o illeggibile)', () => {
  const broken = (id: string) => copyOnDisk(id, ID_A, { downloadKey: 'featured:non-valida' });

  function unreadableStorage() {
    const storage = memoryStorage();
    storage.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"copies": [ rovinato');
    return storage;
  }

  const cases: Array<[string, () => CopyStorage | null]> = [
    ['assente', () => null],
    ['negato', deniedStorage],
    ['pieno (non si scrive)', readOnlyStorage],
    ['illeggibile (JSON rovinato)', unreadableStorage],
  ];

  for (const [name, make] of cases) {
    it(`${name}: nessuna copia si toglie senza risposta del server, e si riprova più tardi`, async () => {
      const storage = make();
      // Una copia non verificabile dal disco (chiave malformata) e una con la chiave giusta.
      const lib = library([broken('l1'), copyOnDisk('l2', ID_B), ownFile('mio-1')]);
      const fetcher = answer({ permitted: [ID_B] });

      const result = await syncFeaturedOfflineCopies({ fetcher, storage, ...lib });

      // Tutto resta: non si sa se la voce della prima copia c'era.
      expect(result).toEqual({ status: 'retry', removed: 0 });
      expect(lib.removeTrack).not.toHaveBeenCalled();
      expect(lib.ids()).toEqual(['l1', 'l2', 'mio-1']);
      // La copia con la chiave giusta si verifica comunque, con l'id letto dal disco.
      expect(sentIds(fetcher)).toEqual([[ID_B]]);
    });

    it(`${name}: anche senza rete resta tutto`, async () => {
      const lib = library([broken('l1'), copyOnDisk('l2', ID_B)]);
      const result = await syncFeaturedOfflineCopies({
        fetcher: vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch,
        storage: make(),
        ...lib,
      });
      expect(result).toEqual({ status: 'retry', removed: 0 });
      expect(lib.removeTrack).not.toHaveBeenCalled();
    });

    it(`${name}: una revoca dichiarata dal server vale lo stesso (l’id è sul disco)`, async () => {
      const storage = make();
      const lib = library([copyOnDisk('l2', ID_B), copyOnDisk('l3', ID_C)]);
      const result = await syncFeaturedOfflineCopies({
        fetcher: answer({ permitted: [ID_C], revoked: [ID_B] }),
        storage,
        ...lib,
      });
      expect(result).toEqual({ status: 'ok', removed: 1 });
      expect(lib.removeTrack).toHaveBeenCalledTimes(1);
      expect(lib.removeTrack).toHaveBeenCalledWith('l2');
      expect(lib.ids()).toEqual(['l3']);
    });
  }

  it('un registro illeggibile non viene mai sovrascritto dalla ricostruzione', async () => {
    const storage = unreadableStorage();
    const lib = library([copyOnDisk('l1', ID_A)]);
    await syncFeaturedOfflineCopies({ fetcher: answer({ permitted: [ID_A] }), storage, ...lib });
    expect(storage.data.get(FEATURED_OFFLINE_COPIES_KEY)).toBe('{"copies": [ rovinato');
    expect(readFeaturedCopyRegistry(storage)).toEqual({ readable: false, copies: [] });
  });

  it('libreria illeggibile: non si tocca nulla', async () => {
    const storage = memoryStorage();
    rememberFeaturedCopy(
      { localId: 'l1', featuredId: ID_A, attribution: null, savedAt: 1 },
      storage,
    );
    const removeTrack = vi.fn(async () => undefined);
    const fetcher = answer({ revoked: [ID_A] });
    const result = await syncFeaturedOfflineCopies({
      fetcher,
      storage,
      removeTrack,
      listTracks: vi.fn(async () => {
        throw new Error('idb');
      }),
    });
    expect(result).toEqual({ status: 'retry', removed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(removeTrack).not.toHaveBeenCalled();
    expect(readFeaturedCopies(storage)).toHaveLength(1);
  });
});

describe('solo il disco decide che cosa si toglie: una voce del registro non basta', () => {
  it('voce del registro su un file dell’ascoltatore + id «revocato» dal server: il file RESTA, la voce si dimentica', async () => {
    const storage = memoryStorage();
    // Registro rovinato o manomesso: indica come copia un file dell'ascoltatore.
    rememberFeaturedCopy(
      { localId: 'mio-1', featuredId: ID_A, attribution: null, savedAt: 1 },
      storage,
    );
    const lib = library([ownFile('mio-1'), ownFile('mio-2')]);
    // Il server dichiara revocato ogni id che non conosce: non deve bastare.
    const fetcher = answer({ revoked: [ID_A] });

    const result = await syncFeaturedOfflineCopies({ fetcher, storage, ...lib });

    expect(result).toEqual({ status: 'skipped', removed: 0 });
    expect(lib.removeTrack).not.toHaveBeenCalled();
    expect(lib.ids()).toEqual(['mio-1', 'mio-2']);
    // Nessuna copia sul disco: al server non si chiede nulla, e la voce falsa non c'è più.
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFeaturedCopies(storage)).toEqual([]);
  });

  it('accanto a una copia vera: si verifica (e si toglie) solo la copia, mai il file dell’ascoltatore', async () => {
    const storage = memoryStorage();
    rememberFeaturedCopies(
      [
        { localId: 'l1', featuredId: ID_A, attribution, savedAt: 1 },
        { localId: 'mio-1', featuredId: ID_B, attribution: null, savedAt: 1 },
      ],
      storage,
    );
    const lib = library([copyOnDisk('l1', ID_A), ownFile('mio-1')]);
    const fetcher = answer({ revoked: [ID_A, ID_B] });

    const result = await syncFeaturedOfflineCopies({ fetcher, storage, ...lib });

    expect(result).toEqual({ status: 'ok', removed: 1 });
    // Al server va solo l'id della copia che il disco riconosce.
    expect(sentIds(fetcher)).toEqual([[ID_A]]);
    expect(lib.removeTrack).toHaveBeenCalledTimes(1);
    expect(lib.removeTrack).toHaveBeenCalledWith('l1');
    expect(lib.ids()).toEqual(['mio-1']);
    expect(readFeaturedCopies(storage)).toEqual([]);
  });

  it('un download Audius o podcast con una voce nel registro non diventa una copia da togliere', async () => {
    const storage = memoryStorage();
    rememberFeaturedCopy(
      { localId: 'a1', featuredId: ID_A, attribution: null, savedAt: 1 },
      storage,
    );
    const lib = library([
      { ...ownFile('a1'), source: 'audius-download', downloadKey: 'trk-1', attribution: null },
    ]);
    const fetcher = answer({ revoked: [ID_A] });
    expect(await syncFeaturedOfflineCopies({ fetcher, storage, ...lib })).toEqual({
      status: 'skipped',
      removed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(lib.ids()).toEqual(['a1']);
  });

  it('registro non scrivibile: la voce falsa resta, ma il file non si tocca comunque', async () => {
    const data = new Map<string, string>();
    const storage = memoryStorage();
    rememberFeaturedCopy(
      { localId: 'mio-1', featuredId: ID_A, attribution: null, savedAt: 1 },
      storage,
    );
    for (const [key, value] of storage.data) data.set(key, value);
    const frozen: CopyStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const lib = library([ownFile('mio-1')]);
    const fetcher = answer({ revoked: [ID_A] });
    const result = await syncFeaturedOfflineCopies({ fetcher, storage: frozen, ...lib });
    expect(result).toEqual({ status: 'skipped', removed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(lib.removeTrack).not.toHaveBeenCalled();
    expect(lib.ids()).toEqual(['mio-1']);
  });
});

describe('una copia revocata che non si riesce a togliere: non è una verifica riuscita', () => {
  it('rimozione fallita → si riprova; la copia e la sua voce restano', async () => {
    const storage = memoryStorage();
    const listTracks = vi.fn(async () => [copyOnDisk('l1', ID_A), copyOnDisk('l2', ID_B)]);
    const removeTrack = vi.fn(async (id: string) => {
      if (id === 'l1') throw new Error('idb');
    });
    const fetcher = answer({ revoked: [ID_A, ID_B] });

    const result = await syncFeaturedOfflineCopies({ fetcher, storage, listTracks, removeTrack });

    // La seconda è stata tolta, la prima no: l'esito chiede di riprovare.
    expect(result).toEqual({ status: 'retry', removed: 1 });
    expect(removeTrack).toHaveBeenCalledTimes(2);
    expect(readFeaturedCopies(storage).map((copy) => copy.localId)).toEqual(['l1']);
  });

  it('…e non blocca la verifica successiva per un minuto (runFeaturedOfflineSync)', async () => {
    const storage = memoryStorage();
    let fail = true;
    const lib = library([copyOnDisk('l1', ID_A)]);
    const removeTrack = vi.fn(async (id: string) => {
      if (fail) throw new Error('idb');
      await lib.removeTrack(id);
    });
    const notify = vi.fn();
    const deps = {
      fetcher: answer({ revoked: [ID_A] }),
      storage,
      listTracks: lib.listTracks,
      removeTrack,
      notify,
    };

    expect(await runFeaturedOfflineSync(deps)).toEqual({ status: 'retry', removed: 0 });
    expect(lib.ids()).toEqual(['l1']);
    expect(notify).not.toHaveBeenCalled();

    // Subito dopo: la verifica riparte (non è passata per riuscita) e stavolta toglie la copia.
    fail = false;
    const again = runFeaturedOfflineSync(deps);
    expect(again).not.toBeNull();
    expect(await again).toEqual({ status: 'ok', removed: 1 });
    expect(lib.ids()).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    // Adesso sì che è riuscita: per un minuto non serve ripeterla.
    expect(runFeaturedOfflineSync(deps)).toBeNull();
  });

  it('vale anche per una copia non verificabile (chiave malformata) che non si riesce a togliere', async () => {
    const storage = memoryStorage();
    const listTracks = vi.fn(async () => [
      copyOnDisk('l1', ID_A, { downloadKey: 'featured:non-valida' }),
    ]);
    const removeTrack = vi.fn(async () => {
      throw new Error('idb');
    });
    const fetcher = answer({});
    expect(await syncFeaturedOfflineCopies({ fetcher, storage, listTracks, removeTrack })).toEqual({
      status: 'retry',
      removed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('libreria che non si legge: non si sa se ci sono copie', () => {
  const unreadable = () =>
    vi.fn(async (): Promise<LocalTrack[]> => {
      throw new Error('idb');
    });

  it('registro vuoto + libreria illeggibile: si riprova (il registro vuoto non dice «nessuna copia»)', async () => {
    // Il browser ha IndexedDB: una libreria può esistere, solo che adesso non si legge.
    vi.stubGlobal('indexedDB', {});
    const fetcher = answer({ revoked: [ID_A] });
    const removeTrack = vi.fn(async () => undefined);
    const result = await syncFeaturedOfflineCopies({
      fetcher,
      storage: memoryStorage(),
      listTracks: unreadable(),
      removeTrack,
    });
    expect(result).toEqual({ status: 'retry', removed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(removeTrack).not.toHaveBeenCalled();
  });

  it('…e la verifica successiva non aspetta un minuto: appena la libreria si legge, la copia revocata va via', async () => {
    vi.stubGlobal('indexedDB', {});
    const storage = memoryStorage();
    const lib = library([copyOnDisk('l1', ID_A)]);
    const listTracks = vi.fn(lib.listTracks).mockRejectedValueOnce(new Error('idb'));
    const deps = {
      fetcher: answer({ revoked: [ID_A] }),
      storage,
      listTracks,
      removeTrack: lib.removeTrack,
      notify: () => undefined,
    };
    expect(await runFeaturedOfflineSync(deps)).toEqual({ status: 'retry', removed: 0 });
    const again = runFeaturedOfflineSync(deps);
    expect(again).not.toBeNull();
    expect(await again).toEqual({ status: 'ok', removed: 1 });
    expect(lib.ids()).toEqual([]);
  });

  it('registro illeggibile, assente o non vuoto: sempre «si riprova», mai «niente da verificare»', async () => {
    const corrupt = memoryStorage();
    corrupt.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"copies": [ rovinato');
    const withEntry = memoryStorage();
    rememberFeaturedCopy(
      { localId: 'l1', featuredId: ID_A, attribution: null, savedAt: 1 },
      withEntry,
    );
    // Anche dove IndexedDB non esiste (qui, in Node): nel dubbio si riprova.
    expect(typeof indexedDB).toBe('undefined');
    for (const storage of [corrupt, null, deniedStorage(), withEntry]) {
      expect(
        await syncFeaturedOfflineCopies({
          fetcher: answer({}),
          storage,
          listTracks: unreadable(),
          removeTrack: vi.fn(async () => undefined),
        }),
      ).toEqual({ status: 'retry', removed: 0 });
    }
  });

  it('browser senza IndexedDB e registro vuoto: nessuna libreria può esistere, niente da verificare', async () => {
    expect(typeof indexedDB).toBe('undefined');
    for (const storage of [memoryStorage(), readOnlyStorage()]) {
      expect(
        await syncFeaturedOfflineCopies({
          fetcher: answer({}),
          storage,
          listTracks: unreadable(),
          removeTrack: vi.fn(async () => undefined),
        }),
      ).toEqual({ status: 'skipped', removed: 0 });
    }
  });
});

describe('la fonte persa torna anche sul disco (una volta per pagina, prima di leggere)', () => {
  it('la riparazione parte prima della lettura, una sola volta finché riesce', async () => {
    const order: string[] = [];
    const repairSources = vi.fn(async () => {
      order.push('repair');
      return 1;
    });
    const listTracks = vi.fn(async () => {
      order.push('list');
      return [copyOnDisk('l1', ID_A)];
    });
    const deps = {
      fetcher: answer({ permitted: [ID_A] }),
      storage: memoryStorage(),
      listTracks,
      removeTrack: vi.fn(async () => undefined),
      repairSources,
    };
    await syncFeaturedOfflineCopies(deps);
    await syncFeaturedOfflineCopies(deps);
    expect(order).toEqual(['repair', 'list', 'list']);
    expect(repairSources).toHaveBeenCalledTimes(1);
  });

  it('una riparazione non riuscita non ferma la verifica, e si ritenta alla successiva', async () => {
    const repairSources = vi
      .fn(async () => 0)
      .mockRejectedValueOnce(new Error('idb in sola lettura'));
    const lib = library([copyOnDisk('l1', ID_A)]);
    const deps = {
      fetcher: answer({ revoked: [ID_A] }),
      storage: memoryStorage(),
      repairSources,
      ...lib,
    };
    // La copia è comunque riconosciuta in lettura: verificata e, revocata, tolta.
    expect(await syncFeaturedOfflineCopies(deps)).toEqual({ status: 'ok', removed: 1 });
    await syncFeaturedOfflineCopies(deps);
    expect(repairSources).toHaveBeenCalledTimes(2);
    await syncFeaturedOfflineCopies(deps);
    expect(repairSources).toHaveBeenCalledTimes(2);
  });
});

describe('promemoria «sul disco non c’è nessuna copia» (per il mount di ogni pagina)', () => {
  it('la verifica lo toglie appena vede una copia sul disco, anche con la voce già nel registro', async () => {
    const storage = memoryStorage();
    // Una scheda con la versione precedente salva una copia e scrive la voce: quella versione
    // non conosce il promemoria e non lo toglie.
    rememberEmptyDiskLook(Date.now(), storage);
    storage.setItem(
      FEATURED_OFFLINE_COPIES_KEY,
      JSON.stringify({
        v: 1,
        copies: [{ localId: 'l1', featuredId: ID_A, attribution: null, savedAt: 1 }],
      }),
    );
    expect(emptyDiskLookIsFresh(Date.now(), storage)).toBe(true);

    const lib = library([copyOnDisk('l1', ID_A)]);
    // Anche se il server non risponde: la copia c'è, e il promemoria non deve dire il contrario.
    const result = await syncFeaturedOfflineCopies({
      fetcher: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      storage,
      ...lib,
    });
    expect(result).toEqual({ status: 'retry', removed: 0 });
    expect(emptyDiskLookIsFresh(Date.now(), storage)).toBe(false);
  });

  it('senza copie sul disco il promemoria resta (non serve riguardare a ogni pagina)', async () => {
    const storage = memoryStorage();
    rememberEmptyDiskLook(Date.now(), storage);
    const lib = library([ownFile('mio-1')]);
    expect(await syncFeaturedOfflineCopies({ fetcher: answer({}), storage, ...lib })).toEqual({
      status: 'skipped',
      removed: 0,
    });
    expect(emptyDiskLookIsFresh(Date.now(), storage)).toBe(true);
  });
});

describe('registro delle copie: lettura e ricostruzione', () => {
  const entry = (localId: string, featuredId: string): FeaturedOfflineCopy => ({
    localId,
    featuredId,
    attribution,
    savedAt: 1,
  });

  it('readFeaturedCopyRegistry distingue «vuoto» da «non si legge»', () => {
    const storage = memoryStorage();
    expect(readFeaturedCopyRegistry(storage)).toEqual({ readable: true, copies: [] });
    rememberFeaturedCopy(entry('l1', ID_A), storage);
    expect(readFeaturedCopyRegistry(storage)).toEqual({
      readable: true,
      copies: [entry('l1', ID_A)],
    });
    storage.setItem(FEATURED_OFFLINE_COPIES_KEY, 'non json');
    expect(readFeaturedCopyRegistry(storage)).toEqual({ readable: false, copies: [] });
    expect(readFeaturedCopyRegistry(null)).toEqual({ readable: false, copies: [] });
    expect(readFeaturedCopyRegistry(deniedStorage())).toEqual({ readable: false, copies: [] });
  });

  it('rememberFeaturedCopies: una scrittura per più voci, corregge quelle esistenti, salta le non valide', () => {
    const storage = memoryStorage();
    rememberFeaturedCopy(entry('l1', ID_A), storage);
    const setItem = vi.spyOn(storage, 'setItem');
    expect(
      rememberFeaturedCopies(
        [entry('l1', ID_B), entry('l2', ID_C), entry('l3', 'non valido')],
        storage,
      ),
    ).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readFeaturedCopies(storage)).toEqual([entry('l1', ID_B), entry('l2', ID_C)]);
    // Registro non scrivibile o assente: false, senza eccezioni.
    expect(rememberFeaturedCopies([entry('l9', ID_A)], readOnlyStorage())).toBe(false);
    expect(rememberFeaturedCopies([entry('l9', ID_A)], null)).toBe(false);
  });
});

describe('dall’inizio alla fine, con la libreria vera su un database in memoria', () => {
  class MemoryDb implements LocalMusicDb {
    data: Record<LocalMusicStoreName, Map<string, unknown>> = {
      tracks: new Map(),
      files: new Map(),
      artwork: new Map(),
    };
    async get(store: LocalMusicStoreName, key: string) {
      return this.data[store].get(key);
    }
    async getAll(store: LocalMusicStoreName) {
      return [...this.data[store].values()];
    }
    async write(ops: readonly LocalMusicWrite[]) {
      for (const op of ops) {
        if (op.op === 'put') this.data[op.store].set(op.key, op.value);
        else this.data[op.store].delete(op.key);
      }
    }
    async update(store: LocalMusicStoreName, key: string, fn: (current: unknown) => unknown) {
      const current = this.data[store].get(key);
      if (current === undefined) return;
      const next = fn(current);
      if (next !== undefined) this.data[store].set(key, next);
    }
    async clear(stores: readonly LocalMusicStoreName[]) {
      for (const store of stores) this.data[store].clear();
    }
  }

  it('copia salvata, fonte riscritta come "local" dalla versione precedente, registro perso: resta revocabile', async () => {
    const db = new MemoryDb();
    let ids = 0;
    const store = createLocalMusicStore({
      db,
      canPlayType: () => 'maybe',
      readTags: async () => emptyTags(),
      probeDuration: async () => ({ seconds: null, timedOut: false }),
      getStorage: () => undefined,
      now: () => 1_000,
      randomId: () => {
        ids += 1;
        return `id-${ids}`;
      },
    });
    await store.addFiles([
      new File([new Uint8Array(10)], `featured:${ID_A}.mp3`, { type: 'audio/mpeg' }),
    ]);
    const saved = await store.addDownloadedTrack({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
      downloadKey: `featured:${ID_A}`,
      source: 'featured-download',
      title: 'Brano concesso',
      artist: 'Banda di prova',
      album: null,
      durationSeconds: null,
      mimeType: 'audio/mpeg',
      attribution,
    });
    expect(saved.ok).toBe(true);
    // Il danno già successo in produzione: la fonte sul disco è diventata 'local'.
    db.data.tracks.set('id-2', {
      ...(db.data.tracks.get('id-2') as object),
      source: 'local',
      durationSeconds: 187,
    });
    // …e il registro in localStorage non c'è più.
    const storage = memoryStorage();
    const deps = {
      storage,
      listTracks: store.listTracks,
      removeTrack: store.removeTrack,
      repairSources: store.repairFeaturedCopySources,
    };

    // Verifica con il brano ancora consentito: la copia resta, la voce torna.
    expect(
      await syncFeaturedOfflineCopies({ fetcher: answer({ permitted: [ID_A] }), ...deps }),
    ).toEqual({ status: 'ok', removed: 0 });
    expect(readFeaturedCopies(storage)).toEqual([
      { localId: 'id-2', featuredId: ID_A, attribution, savedAt: 1_000 },
    ]);
    expect(await store.listTracks()).toHaveLength(2);
    // …e il record sul disco torna a dire da sé che cos'è; il file dell'ascoltatore non cambia.
    expect(db.data.tracks.get('id-2')).toMatchObject({
      source: 'featured-download',
      durationSeconds: 187,
    });
    expect(db.data.tracks.get('id-1')).toMatchObject({ source: 'local' });

    // Revoca: la copia sparisce dal dispositivo, il file dell'ascoltatore con lo stesso nome no.
    expect(
      await syncFeaturedOfflineCopies({ fetcher: answer({ revoked: [ID_A] }), ...deps }),
    ).toEqual({ status: 'ok', removed: 1 });
    const left = await store.listTracks();
    expect(left.map((track) => track.id)).toEqual(['id-1']);
    expect(left[0]?.source).toBeUndefined();
    expect(db.data.files.has('id-2')).toBe(false);
    expect(readFeaturedCopies(storage)).toEqual([]);
  });

  it('file dell’ascoltatore con una voce falsa nel registro: il server lo «revoca», il file resta sul dispositivo', async () => {
    const db = new MemoryDb();
    const store = createLocalMusicStore({
      db,
      canPlayType: () => 'maybe',
      readTags: async () => emptyTags(),
      probeDuration: async () => ({ seconds: null, timedOut: false }),
      getStorage: () => undefined,
      now: () => 1_000,
      randomId: () => 'id-1',
    });
    await store.addFiles([new File([new Uint8Array(10)], 'mio.mp3', { type: 'audio/mpeg' })]);
    const storage = memoryStorage();
    rememberFeaturedCopy(
      { localId: 'id-1', featuredId: ID_C, attribution: null, savedAt: 1 },
      storage,
    );
    const fetcher = answer({ revoked: [ID_C] });

    const result = await syncFeaturedOfflineCopies({
      fetcher,
      storage,
      listTracks: store.listTracks,
      removeTrack: store.removeTrack,
      repairSources: store.repairFeaturedCopySources,
    });

    expect(result).toEqual({ status: 'skipped', removed: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await store.listTracks()).map((track) => track.id)).toEqual(['id-1']);
    expect(db.data.files.has('id-1')).toBe(true);
    expect(db.data.tracks.get('id-1')).toMatchObject({ source: 'local' });
    expect(readFeaturedCopies(storage)).toEqual([]);
  });
});
