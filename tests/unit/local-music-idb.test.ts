// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbAdapter,
  LOCAL_MUSIC_DB_NAME,
  LOCAL_MUSIC_DB_VERSION,
  LocalMusicUnavailableError,
} from '@/lib/local-music/idb';
import { createLocalMusicStore } from '@/lib/local-music/store';
import { emptyTags } from '@/lib/local-music/types';

// --- IndexedDB finto: il minimo che usa l'adattatore -----------------------------------------
// Richieste asincrone, transazioni atomiche (le scritture vanno su una copia e si applicano solo
// al commit), abort con tx.error quando una richiesta fallisce o il commit supera la quota.

type Stores = Map<string, Map<string, unknown>>;

class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: ((event: { target: FakeRequest }) => void) | null = null;
  onerror: ((event: { target: FakeRequest }) => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: ((event: { target: FakeRequest }) => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  private readonly staged: Stores;
  private pending = 0;
  private finished = false;

  constructor(
    private readonly connection: FakeConnection,
    private readonly mode: string,
    names: string[],
  ) {
    this.staged = new Map(
      names.map((name) => [name, new Map(connection.backend.stores.get(name))]),
    );
    setTimeout(() => this.maybeCommit(), 0);
  }

  objectStore(name: string) {
    const store = this.staged.get(name);
    if (!store) throw new DOMException('Fuori dallo scope', 'NotFoundError');
    const backend = this.connection.backend;
    const request = (run: () => unknown) => {
      const req = new FakeRequest();
      this.pending += 1;
      queueMicrotask(() => {
        this.pending -= 1;
        if (this.finished) return;
        try {
          req.result = run();
          req.onsuccess?.({ target: req });
        } catch (error) {
          req.error = error;
          req.onerror?.({ target: req });
          this.onerror?.({ target: req });
          this.abort(error);
        }
      });
      return req;
    };
    const writable = () => {
      if (this.mode !== 'readwrite') throw new DOMException('Sola lettura', 'ReadOnlyError');
    };
    return {
      get: (key: string) => request(() => store.get(key)),
      getAll: () => request(() => [...store.values()]),
      put: (value: unknown, key: string) => {
        writable();
        return request(() => {
          const error = backend.failPut?.(value);
          if (error) throw error;
          store.set(key, value);
          return key;
        });
      },
      delete: (key: string) => {
        writable();
        return request(() => {
          store.delete(key);
        });
      },
      clear: () => {
        writable();
        return request(() => {
          store.clear();
        });
      },
    };
  }

  abort(error: unknown = null) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    setTimeout(() => this.onabort?.(), 0);
  }

  private maybeCommit() {
    if (this.finished) return;
    if (this.pending > 0) {
      setTimeout(() => this.maybeCommit(), 0);
      return;
    }
    const backend = this.connection.backend;
    if (this.mode === 'readwrite' && backend.failCommit) {
      const error = backend.failCommit;
      backend.failCommit = null;
      this.abort(error);
      return;
    }
    this.finished = true;
    if (this.mode === 'readwrite') {
      for (const [name, data] of this.staged) backend.stores.set(name, data);
    }
    this.oncomplete?.();
  }
}

class FakeConnection {
  closed = false;
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly objectStoreNames = { contains: (name: string) => this.backend.stores.has(name) };

  constructor(readonly backend: FakeBackend) {}

  createObjectStore(name: string) {
    this.backend.stores.set(name, new Map());
  }

  transaction(names: string[], mode: string) {
    if (this.closed) throw new DOMException('Connessione chiusa', 'InvalidStateError');
    for (const name of names) {
      if (!this.backend.stores.has(name)) throw new DOMException(name, 'NotFoundError');
    }
    return new FakeTransaction(this, mode, names);
  }

  close() {
    this.closed = true;
  }
}

class FakeBackend {
  stores: Stores = new Map();
  version = 0;
  opens: Array<{ name: string; version: number }> = [];
  upgrades = 0;
  connections: FakeConnection[] = [];
  failOpen: unknown = null;
  failPut: ((value: unknown) => unknown) | null = null;
  failCommit: unknown = null;

  readonly factory = {
    open: (name: string, version: number) => {
      this.opens.push({ name, version });
      const request = new FakeRequest();
      setTimeout(() => {
        if (this.failOpen) {
          request.error = this.failOpen;
          request.onerror?.({ target: request });
          return;
        }
        const connection = new FakeConnection(this);
        this.connections.push(connection);
        request.result = connection;
        if (this.version < version) {
          this.upgrades += 1;
          request.onupgradeneeded?.();
          this.version = version;
        }
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    },
  };

  adapter() {
    return createIndexedDbAdapter(() => this.factory as unknown as IDBFactory);
  }
}

describe('IndexedDB adapter', () => {
  it('opens solco-local-music v1 and creates the three stores once', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    expect(await db.getAll('tracks')).toEqual([]);
    expect(await db.get('files', 'x')).toBeUndefined();
    expect(backend.opens).toEqual([{ name: LOCAL_MUSIC_DB_NAME, version: LOCAL_MUSIC_DB_VERSION }]);
    expect([...backend.stores.keys()].sort()).toEqual(['artwork', 'files', 'tracks']);
    expect(backend.upgrades).toBe(1);

    // Una seconda istanza (nuova pagina) riapre senza aggiornare lo schema.
    await backend.adapter().getAll('tracks');
    expect(backend.upgrades).toBe(1);
  });

  it('writes several stores atomically and reads them back', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    await db.write([
      { op: 'put', store: 'files', key: 't1', value: blob },
      { op: 'put', store: 'tracks', key: 't1', value: { id: 't1' } },
    ]);
    expect(await db.get('files', 't1')).toBe(blob);
    expect(await db.getAll('tracks')).toEqual([{ id: 't1' }]);

    await db.write([{ op: 'delete', store: 'files', key: 't1' }]);
    expect(await db.get('files', 't1')).toBeUndefined();
    await db.clear(['tracks']);
    expect(await db.getAll('tracks')).toEqual([]);
    await db.write([]);
    await db.clear([]);
  });

  it('updates a value in one readwrite transaction and skips missing keys', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    await db.write([{ op: 'put', store: 'tracks', key: 't1', value: { id: 't1', n: 1 } }]);
    await db.update('tracks', 't1', (current) => ({ ...(current as object), n: 2 }));
    expect(await db.get('tracks', 't1')).toEqual({ id: 't1', n: 2 });

    const ghost = vi.fn(() => ({ id: 'fantasma' }));
    await db.update('tracks', 'manca', ghost);
    expect(ghost).not.toHaveBeenCalled();
    expect(await db.get('tracks', 'manca')).toBeUndefined();

    await db.update('tracks', 't1', () => undefined);
    expect(await db.get('tracks', 't1')).toEqual({ id: 't1', n: 2 });

    const boom = new Error('boom');
    await expect(
      db.update('tracks', 't1', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await db.get('tracks', 't1')).toEqual({ id: 't1', n: 2 });
  });

  it('rejects with QuotaExceededError when a put fails, committing nothing', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    backend.failPut = (value) =>
      value instanceof Blob ? new DOMException('Spazio esaurito', 'QuotaExceededError') : null;
    await expect(
      db.write([
        { op: 'put', store: 'tracks', key: 't1', value: { id: 't1' } },
        { op: 'put', store: 'files', key: 't1', value: new Blob(['x']) },
      ]),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await db.getAll('tracks')).toEqual([]);
  });

  it('rejects with QuotaExceededError when the commit fails', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    backend.failCommit = new DOMException('Spazio esaurito', 'QuotaExceededError');
    await expect(
      db.write([{ op: 'put', store: 'tracks', key: 't1', value: { id: 't1' } }]),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await db.get('tracks', 't1')).toBeUndefined();
  });

  it('reopens once when the browser closes the connection', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    await db.write([{ op: 'put', store: 'tracks', key: 't1', value: { id: 't1' } }]);
    backend.connections[0]?.close(); // WebKit che perde la connessione in background
    expect(await db.get('tracks', 't1')).toEqual({ id: 't1' });
    expect(backend.opens).toHaveLength(2);
  });

  it('closes on versionchange and reconnects on the next call', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    await db.getAll('tracks');
    const first = backend.connections[0];
    first?.onversionchange?.();
    expect(first?.closed).toBe(true);
    await db.getAll('tracks');
    expect(backend.opens).toHaveLength(2);
  });

  it('reports a missing or broken IndexedDB as unavailable and retries the open later', async () => {
    await expect(createIndexedDbAdapter(() => undefined).getAll('tracks')).rejects.toBeInstanceOf(
      LocalMusicUnavailableError,
    );
    await expect(
      createIndexedDbAdapter(() => {
        throw new Error('SecurityError');
      }).getAll('tracks'),
    ).rejects.toBeInstanceOf(LocalMusicUnavailableError);

    const backend = new FakeBackend();
    const db = backend.adapter();
    backend.failOpen = new DOMException('Privato', 'InvalidStateError');
    await expect(db.getAll('tracks')).rejects.toBeInstanceOf(LocalMusicUnavailableError);
    backend.failOpen = null;
    expect(await db.getAll('tracks')).toEqual([]);
    expect(backend.opens).toHaveLength(2);
  });

  it('does not retry non-connection errors', async () => {
    const backend = new FakeBackend();
    const db = backend.adapter();
    backend.failPut = () => new DOMException('Clonazione', 'DataCloneError');
    await expect(
      db.write([{ op: 'put', store: 'tracks', key: 't1', value: {} }]),
    ).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(backend.opens).toHaveLength(1);
  });

  it('runs the library on top of it, skipping a file that exceeds the quota', async () => {
    const backend = new FakeBackend();
    let ids = 0;
    const store = createLocalMusicStore({
      db: backend.adapter(),
      canPlayType: () => 'maybe',
      readTags: async () => emptyTags(),
      probeDuration: async () => ({ seconds: 60, timedOut: false }),
      getStorage: () => undefined,
      now: () => 1,
      randomId: () => {
        ids += 1;
        return `id-${ids}`;
      },
    });
    backend.failPut = (value) =>
      value instanceof Blob && value.size > 100
        ? new DOMException('Spazio esaurito', 'QuotaExceededError')
        : null;
    const result = await store.addFiles([
      new File([new Uint8Array(10)], 'Band - Piccolo.mp3', { type: 'audio/mpeg' }),
      new File([new Uint8Array(500)], 'Band - Grande.mp3', { type: 'audio/mpeg' }),
    ]);
    expect(result.skipped).toEqual([{ name: 'Band - Grande.mp3', reason: 'quota' }]);
    expect((await store.listTracks()).map((track) => track.title)).toEqual(['Piccolo']);
    expect(backend.stores.get('files')?.size).toBe(1);
    expect((await store.getTrackBlob('id-1'))?.type).toBe('audio/mpeg');
    await store.setTrackDuration('id-1', 61.5);
    expect((await store.getTrack('id-1'))?.durationSeconds).toBe(61.5);
    await store.removeTrack('id-1');
    await store.setTrackDuration('id-1', 99);
    expect(await store.listTracks()).toEqual([]);
  });
});
