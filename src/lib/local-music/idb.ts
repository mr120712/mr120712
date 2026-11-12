// @polsia:user-owned — adattatore IndexedDB minimo per la libreria musicale del dispositivo.
//
// Database 'solco-local-music' v1 con tre object store a chiave esterna (l'id del brano):
// 'tracks' (metadati), 'files' (Blob audio) e 'artwork' (Blob copertina). La logica della
// libreria (store.ts) parla solo con l'interfaccia LocalMusicDb, così i test usano un database in
// memoria; qui c'è l'unica implementazione reale.
//
// Ogni operazione apre una transazione e vi accoda tutte le richieste in modo sincrono (nessun
// await dentro la transazione, che altrimenti si chiuderebbe da sola), e si risolve solo a
// transazione completata: una scrittura riuscita è davvero su disco. Se il browser chiude la
// connessione (cambio versione, WebKit che la perde quando l'app torna dal background) la si
// riapre una volta e si riprova.

export const LOCAL_MUSIC_DB_NAME = 'solco-local-music';
export const LOCAL_MUSIC_DB_VERSION = 1;
export const LOCAL_MUSIC_STORES = ['tracks', 'files', 'artwork'] as const;

export type LocalMusicStoreName = (typeof LOCAL_MUSIC_STORES)[number];

export type LocalMusicWrite =
  | { op: 'put'; store: LocalMusicStoreName; key: string; value: unknown }
  | { op: 'delete'; store: LocalMusicStoreName; key: string };

/** Il minimo di IndexedDB che serve alla libreria. */
export interface LocalMusicDb {
  get(store: LocalMusicStoreName, key: string): Promise<unknown>;
  getAll(store: LocalMusicStoreName): Promise<unknown[]>;
  /** Tutte le scritture in un'unica transazione: o tutte o nessuna. */
  write(ops: readonly LocalMusicWrite[]): Promise<void>;
  /**
   * Legge e riscrive un valore nella stessa transazione readwrite, così nessuna rimozione può
   * infilarsi tra lettura e scrittura. Una chiave assente è saltata (`fn` non viene chiamata);
   * `fn` è sincrona e restituisce il nuovo valore, o undefined per non scrivere nulla.
   */
  update(
    store: LocalMusicStoreName,
    key: string,
    fn: (current: unknown) => unknown | undefined,
  ): Promise<void>;
  clear(stores: readonly LocalMusicStoreName[]): Promise<void>;
}

/** IndexedDB assente o non apribile (vecchi browser, alcune modalità private). */
export class LocalMusicUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      'La libreria sul dispositivo non è disponibile in questo browser.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'LocalMusicUnavailableError';
  }
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
}

/** Connessione chiusa o persa: vale la pena riaprire e riprovare una volta. */
function isConnectionError(error: unknown): boolean {
  const name = errorName(error);
  return name === 'InvalidStateError' || name === 'UnknownError';
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(LOCAL_MUSIC_DB_NAME, LOCAL_MUSIC_DB_VERSION);
    } catch (error) {
      reject(new LocalMusicUnavailableError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of LOCAL_MUSIC_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new LocalMusicUnavailableError(request.error));
  });
}

function runTransaction<T>(
  db: IDBDatabase,
  stores: readonly LocalMusicStoreName[],
  mode: IDBTransactionMode,
  queue: (tx: IDBTransaction) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([...stores], mode);
    } catch (error) {
      reject(error);
      return;
    }
    let request: IDBRequest<T> | undefined;
    let requestError: unknown = null;
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = (event) => {
      const target = event.target as { error?: unknown } | null;
      requestError = target?.error ?? tx.error ?? requestError;
    };
    // La quota esaurita può arrivare da una richiesta o solo al commit: in entrambi i casi la
    // transazione abortisce con l'errore (QuotaExceededError).
    tx.onabort = () => {
      reject(tx.error ?? requestError ?? new DOMException('Transazione annullata', 'AbortError'));
    };
    try {
      request = queue(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Già terminata.
      }
      reject(error);
    }
  });
}

/**
 * LocalMusicDb su IndexedDB. La connessione si apre alla prima operazione (import sicuro anche
 * lato server) e si riapre se il browser la chiude.
 */
export function createIndexedDbAdapter(
  getFactory: () => IDBFactory | undefined = () =>
    typeof indexedDB === 'undefined' ? undefined : indexedDB,
): LocalMusicDb {
  let connection: Promise<IDBDatabase> | null = null;

  function connect(): Promise<IDBDatabase> {
    if (connection) return connection;
    let factory: IDBFactory | undefined;
    try {
      factory = getFactory();
    } catch {
      factory = undefined;
    }
    if (!factory) return Promise.reject(new LocalMusicUnavailableError());
    const opening = openDatabase(factory).then((db) => {
      db.onversionchange = () => {
        db.close();
        if (connection === opening) connection = null;
      };
      (db as IDBDatabase & { onclose: (() => void) | null }).onclose = () => {
        if (connection === opening) connection = null;
      };
      return db;
    });
    connection = opening;
    // Un'apertura fallita non resta in cache: la prossima operazione riprova.
    opening.catch(() => {
      if (connection === opening) connection = null;
    });
    return opening;
  }

  async function withDb<T>(operation: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await connect();
    try {
      return await operation(db);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      if (connection) {
        const stale = connection;
        connection = null;
        stale.then((old) => old.close()).catch(() => {});
      }
      return operation(await connect());
    }
  }

  return {
    get(store, key) {
      return withDb((db) =>
        runTransaction(db, [store], 'readonly', (tx) => tx.objectStore(store).get(key)),
      );
    },
    async getAll(store) {
      const rows = await withDb((db) =>
        runTransaction(db, [store], 'readonly', (tx) => tx.objectStore(store).getAll()),
      );
      return Array.isArray(rows) ? rows : [];
    },
    async write(ops) {
      if (ops.length === 0) return;
      const stores = [...new Set(ops.map((op) => op.store))];
      await withDb((db) =>
        runTransaction(db, stores, 'readwrite', (tx) => {
          for (const op of ops) {
            const objectStore = tx.objectStore(op.store);
            if (op.op === 'put') objectStore.put(op.value, op.key);
            else objectStore.delete(op.key);
          }
          return undefined;
        }),
      );
    },
    async update(store, key, fn) {
      // Un errore di `fn` (o della put) annulla la transazione: lo si restituisce così com'è.
      const failure: { thrown: boolean; error: unknown } = { thrown: false, error: undefined };
      try {
        await withDb((db) =>
          runTransaction(db, [store], 'readwrite', (tx) => {
            const objectStore = tx.objectStore(store);
            const request = objectStore.get(key);
            request.onsuccess = () => {
              if (request.result === undefined) return;
              try {
                const next = fn(request.result);
                if (next !== undefined) objectStore.put(next, key);
              } catch (error) {
                failure.thrown = true;
                failure.error = error;
                try {
                  tx.abort();
                } catch {
                  // Già terminata.
                }
              }
            };
            return undefined;
          }),
        );
      } catch (error) {
        throw failure.thrown ? failure.error : error;
      }
    },
    async clear(stores) {
      if (stores.length === 0) return;
      await withDb((db) =>
        runTransaction(db, stores, 'readwrite', (tx) => {
          for (const store of stores) tx.objectStore(store).clear();
          return undefined;
        }),
      );
    },
  };
}
