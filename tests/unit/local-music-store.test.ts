// @polsia:user-owned
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalMusicDb, LocalMusicStoreName, LocalMusicWrite } from '@/lib/local-music/idb';
import {
  browserCanPlayType,
  DURATION_PROBE_TIMEOUT_MS,
  type DurationProbe,
  type ProbeAudioElement,
  probeDuration,
  resolveAudioType,
} from '@/lib/local-music/media';
import {
  createObjectUrlForArtwork,
  createObjectUrlForTrack,
  objectUrlHandle,
} from '@/lib/local-music/playback';
import {
  createLocalMusicStore,
  isQuotaError,
  type LocalMusicStoreDeps,
  MAX_IN_MEMORY_RETRY_BYTES,
  type StorageManagerLike,
} from '@/lib/local-music/store';
import { readAudioTags } from '@/lib/local-music/tags';
import { type AudioTags, emptyTags, MAX_LOCAL_FILE_BYTES } from '@/lib/local-music/types';

// --- Database in memoria ---------------------------------------------------------------------

class MemoryDb implements LocalMusicDb {
  data: Record<LocalMusicStoreName, Map<string, unknown>> = {
    tracks: new Map(),
    files: new Map(),
    artwork: new Map(),
  };
  writes: LocalMusicWrite[][] = [];
  failWrite: ((ops: readonly LocalMusicWrite[]) => unknown) | null = null;
  failReads: unknown = null;

  async get(store: LocalMusicStoreName, key: string) {
    if (this.failReads) throw this.failReads;
    return this.data[store].get(key);
  }

  async getAll(store: LocalMusicStoreName) {
    if (this.failReads) throw this.failReads;
    return [...this.data[store].values()];
  }

  async write(ops: readonly LocalMusicWrite[]) {
    const error = this.failWrite?.(ops);
    if (error) throw error;
    this.writes.push([...ops]);
    for (const op of ops) {
      if (op.op === 'put') this.data[op.store].set(op.key, op.value);
      else this.data[op.store].delete(op.key);
    }
  }

  /** Come IndexedDB: lettura e scrittura atomiche (nessun await in mezzo). */
  async update(store: LocalMusicStoreName, key: string, fn: (current: unknown) => unknown) {
    const current = this.data[store].get(key);
    if (current === undefined) return;
    const next = fn(current);
    if (next !== undefined) await this.write([{ op: 'put', store, key, value: next }]);
  }

  async clear(stores: readonly LocalMusicStoreName[]) {
    for (const store of stores) this.data[store].clear();
  }
}

const PLAYABLE = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/ogg']);

function makeStore(overrides: Partial<LocalMusicStoreDeps> = {}) {
  const db = new MemoryDb();
  let ids = 0;
  let clock = 1_000;
  const probe = vi.fn(
    async (_blob: Blob): Promise<DurationProbe> => ({ seconds: 180, timedOut: false }),
  );
  const readTags = vi.fn(async (_blob: Blob): Promise<AudioTags> => emptyTags());
  const store = createLocalMusicStore({
    db,
    canPlayType: (mime) => (PLAYABLE.has(mime) ? 'maybe' : ''),
    readTags,
    probeDuration: probe,
    getStorage: () => undefined,
    now: () => {
      clock += 10;
      return clock;
    },
    randomId: () => {
      ids += 1;
      return `id-${ids}`;
    },
    ...overrides,
  });
  return { store, db, probe, readTags };
}

function audioFile(name: string, { size = 1000, type = 'audio/mpeg', lastModified = 1 } = {}) {
  return new File([new Uint8Array(size)], name, { type, lastModified });
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0xff, 0xd9];

// --- addFiles --------------------------------------------------------------------------------

describe('addFiles', () => {
  it('stores metadata, the typed audio Blob and the artwork in one write', async () => {
    const { store, db, readTags } = makeStore();
    readTags.mockResolvedValueOnce({
      title: 'Titolo',
      artist: 'Artista',
      album: 'Album',
      artwork: { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) },
      durationSeconds: null,
    });
    const result = await store.addFiles([audioFile('qualcosa.mp3', { lastModified: 5 })]);

    expect(result.skipped).toEqual([]);
    expect(result.added).toEqual([
      {
        id: 'id-1',
        title: 'Titolo',
        artist: 'Artista',
        album: 'Album',
        durationSeconds: 180,
        mimeType: 'audio/mpeg',
        size: 1000,
        addedAt: 1010,
        hasArtwork: true,
      },
    ]);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.map((op) => op.store).sort()).toEqual(['artwork', 'files', 'tracks']);

    const audio = await store.getTrackBlob('id-1');
    expect(audio?.type).toBe('audio/mpeg');
    expect(audio?.size).toBe(1000);
    const artwork = await store.getArtworkBlob('id-1');
    expect(artwork?.type).toBe('image/jpeg');
    expect(new Uint8Array(await (artwork as Blob).arrayBuffer())).toEqual(new Uint8Array(JPEG));
    expect(await store.listTracks()).toEqual(result.added);
  });

  it('reads real ID3 tags end to end', async () => {
    const { store } = makeStore({ readTags: readAudioTags });
    const title = [0x54, 0x49, 0x54, 0x32, 0, 0, 0, 6, 0, 0, 0, 0x43, 0x69, 0x61, 0x6f, 0x21];
    const tag = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, title.length, ...title];
    const file = new File([new Uint8Array([...tag, ...new Array(200).fill(0)])], 'x.mp3', {
      type: 'audio/mpeg',
    });
    const { added } = await store.addFiles([file]);
    expect(added[0]).toMatchObject({ title: 'Ciao!', artist: null, hasArtwork: false });
  });

  it('falls back to the file name when there are no tags', async () => {
    const { store } = makeStore();
    const { added } = await store.addFiles([
      audioFile('Lucio Dalla - Caruso.mp3'),
      audioFile('Solo titolo.mp3'),
    ]);
    expect(added.map(({ title, artist, album }) => ({ title, artist, album }))).toEqual([
      { title: 'Caruso', artist: 'Lucio Dalla', album: null },
      { title: 'Solo titolo', artist: null, album: null },
    ]);
  });

  it('keeps a tag title without guessing the artist from the file name', async () => {
    const { store, readTags } = makeStore();
    readTags.mockResolvedValueOnce({ ...emptyTags(), title: 'Dal tag' });
    readTags.mockResolvedValueOnce({ ...emptyTags(), artist: 'Solo artista' });
    const { added } = await store.addFiles([
      audioFile('Altro - Nome.mp3'),
      audioFile('Altro - Brano.mp3'),
    ]);
    expect(added[0]).toMatchObject({ title: 'Dal tag', artist: null });
    expect(added[1]).toMatchObject({ title: 'Brano', artist: 'Solo artista' });
  });

  it('rejects files the browser cannot play, empty files and non-audio types', async () => {
    const { store } = makeStore();
    const result = await store.addFiles([
      audioFile('note.txt', { type: 'text/plain' }),
      audioFile('brano.flac', { type: 'audio/flac' }),
      audioFile('video.mp4', { type: 'video/mp4' }),
      audioFile('vuoto.mp3', { size: 0 }),
      audioFile('wma.wma', { type: 'audio/x-ms-wma' }),
      audioFile('mistero', { type: '' }),
    ]);
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'note.txt', reason: 'unsupported' },
      { name: 'brano.flac', reason: 'unsupported' },
      { name: 'video.mp4', reason: 'unsupported' },
      { name: 'vuoto.mp3', reason: 'unsupported' },
      { name: 'wma.wma', reason: 'unsupported' },
      { name: 'mistero', reason: 'unsupported' },
    ]);
  });

  it('uses the extension when the type is missing and normalises aliases', async () => {
    const { store, db } = makeStore({
      canPlayType: (mime) => (mime === 'audio/x-m4a' || mime === 'audio/mpeg' ? 'maybe' : ''),
    });
    const { added } = await store.addFiles([
      audioFile('a.m4a', { type: '' }),
      audioFile('b.mp3', { type: 'application/octet-stream' }),
      audioFile('c.mp3', { type: 'audio/mp3' }),
    ]);
    expect(added.map((track) => track.mimeType)).toEqual([
      'audio/x-m4a',
      'audio/mpeg',
      'audio/mpeg',
    ]);
    expect((db.data.files.get('id-1') as Blob).type).toBe('audio/x-m4a');
  });

  it('rejects files over 200 MiB', async () => {
    const { store, readTags } = makeStore();
    const big = audioFile('lungo.mp3', { size: 10 });
    Object.defineProperty(big, 'size', { value: MAX_LOCAL_FILE_BYTES + 1 });
    const ok = audioFile('limite.mp3', { size: 10 });
    Object.defineProperty(ok, 'size', { value: MAX_LOCAL_FILE_BYTES });
    const result = await store.addFiles([big, ok]);
    expect(result.skipped).toEqual([{ name: 'lungo.mp3', reason: 'too_large' }]);
    expect(result.added).toHaveLength(1);
    expect(readTags).toHaveBeenCalledTimes(1);
  });

  it('skips duplicates (same name + size + lastModified) within and across batches', async () => {
    const { store } = makeStore();
    const first = await store.addFiles([
      audioFile('uno.mp3', { lastModified: 1 }),
      audioFile('uno.mp3', { lastModified: 1 }),
      audioFile('uno.mp3', { lastModified: 2 }),
      audioFile('uno.mp3', { lastModified: 1, size: 999 }),
    ]);
    expect(first.added).toHaveLength(3);
    expect(first.skipped).toEqual([{ name: 'uno.mp3', reason: 'duplicate' }]);

    const second = await store.addFiles([audioFile('uno.mp3', { lastModified: 2 })]);
    expect(second.skipped).toEqual([{ name: 'uno.mp3', reason: 'duplicate' }]);
  });

  it('serialises concurrent batches so they cannot duplicate each other', async () => {
    const { store } = makeStore();
    const [a, b] = await Promise.all([
      store.addFiles([audioFile('stesso.mp3')]),
      store.addFiles([audioFile('stesso.mp3')]),
    ]);
    expect(a.added).toHaveLength(1);
    expect(b.skipped).toEqual([{ name: 'stesso.mp3', reason: 'duplicate' }]);
  });

  it('marks quota errors without breaking the batch', async () => {
    const { store, db } = makeStore();
    db.failWrite = (ops) =>
      ops.some((op) => op.op === 'put' && op.store === 'files' && (op.value as Blob).size > 5000)
        ? new DOMException('Spazio esaurito', 'QuotaExceededError')
        : null;
    const result = await store.addFiles([
      audioFile('piccolo.mp3'),
      audioFile('grande.mp3', { size: 6000 }),
      audioFile('ancora.mp3'),
    ]);
    expect(result.added.map((track) => track.title)).toEqual(['piccolo', 'ancora']);
    expect(result.skipped).toEqual([{ name: 'grande.mp3', reason: 'quota' }]);
    expect(db.data.tracks.size).toBe(2);
  });

  it('marks unexpected database failures as errors and does not remember them as added', async () => {
    const { store, db } = makeStore();
    let attempts = 0;
    db.failWrite = () => {
      attempts += 1;
      return new DOMException('disco', 'UnknownError');
    };
    const result = await store.addFiles([audioFile('x.mp3')]);
    expect(result.skipped).toEqual([{ name: 'x.mp3', reason: 'error' }]);
    expect(attempts).toBe(2); // file originale + copia in memoria
    db.failWrite = null;
    expect((await store.addFiles([audioFile('x.mp3')])).added).toHaveLength(1);
  });

  it('retries a failed audio write once with an in-memory copy (WebKit File-backed Blob)', async () => {
    const { store, db } = makeStore();
    const attempts: Blob[] = [];
    db.failWrite = (ops) => {
      const put = ops.find((op) => op.op === 'put' && op.store === 'files');
      if (put?.op === 'put') attempts.push(put.value as Blob);
      return attempts.length === 1
        ? new DOMException('Error preparing Blob/File data to be stored', 'UnknownError')
        : null;
    };
    const result = await store.addFiles([audioFile('a.mp3', { size: 1000 })]);
    expect(result.skipped).toEqual([]);
    expect(result.added).toMatchObject([{ id: 'id-1', size: 1000, mimeType: 'audio/mpeg' }]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]);
    const stored = await store.getTrackBlob('id-1');
    expect(stored).toBe(attempts[1]);
    expect(stored?.type).toBe('audio/mpeg');
    expect(stored?.size).toBe(1000);
    expect(db.data.tracks.size).toBe(1);
  });

  it('does not retry quota errors or files over 50 MiB, and reports a quota hit on the retry', async () => {
    const quota = makeStore();
    let quotaAttempts = 0;
    quota.db.failWrite = () => {
      quotaAttempts += 1;
      return new DOMException('Spazio esaurito', 'QuotaExceededError');
    };
    expect((await quota.store.addFiles([audioFile('q.mp3')])).skipped).toEqual([
      { name: 'q.mp3', reason: 'quota' },
    ]);
    expect(quotaAttempts).toBe(1);

    const big = makeStore();
    let bigAttempts = 0;
    big.db.failWrite = () => {
      bigAttempts += 1;
      return new DOMException('disco', 'UnknownError');
    };
    const file = audioFile('grande.mp3', { size: 10 });
    Object.defineProperty(file, 'size', { value: MAX_IN_MEMORY_RETRY_BYTES + 1 });
    expect((await big.store.addFiles([file])).skipped).toEqual([
      { name: 'grande.mp3', reason: 'error' },
    ]);
    expect(bigAttempts).toBe(1);

    const full = makeStore();
    let fullAttempts = 0;
    full.db.failWrite = () => {
      fullAttempts += 1;
      return fullAttempts === 1
        ? new DOMException('disco', 'UnknownError')
        : new DOMException('Spazio esaurito', 'QuotaExceededError');
    };
    expect((await full.store.addFiles([audioFile('f.mp3')])).skipped).toEqual([
      { name: 'f.mp3', reason: 'quota' },
    ]);
  });

  it('rejects when the library cannot be opened', async () => {
    const { store, db } = makeStore();
    db.failReads = new Error('IndexedDB non disponibile');
    await expect(store.addFiles([audioFile('x.mp3')])).rejects.toThrow('IndexedDB non disponibile');
    db.failReads = null;
    expect((await store.addFiles([audioFile('x.mp3')])).added).toHaveLength(1);
  });

  it('reports progress after each file and survives a throwing callback', async () => {
    const { store } = makeStore();
    const progress = vi.fn(() => {
      throw new Error('UI rotta');
    });
    const result = await store.addFiles(
      [audioFile('a.mp3'), audioFile('b.txt', { type: 'text/plain' }), audioFile('c.mp3')],
      { onProgress: progress },
    );
    expect(result.added).toHaveLength(2);
    expect(progress.mock.calls).toEqual([
      [{ processed: 1, total: 3, fileName: 'a.mp3' }],
      [{ processed: 2, total: 3, fileName: 'b.txt' }],
      [{ processed: 3, total: 3, fileName: 'c.mp3' }],
    ]);
  });

  it('sanitises skipped file names', async () => {
    const { store } = makeStore();
    const result = await store.addFiles([audioFile('‮bad\u0007.txt', { type: 'text/plain' })]);
    expect(result.skipped).toEqual([{ name: 'bad.txt', reason: 'unsupported' }]);
  });

  it('copies the file list right away, so resetting the <input> cannot empty the batch', async () => {
    const { store } = makeStore();
    const busy = store.addFiles([audioFile('prima.mp3')]); // un lotto già in fila
    const picked = [audioFile('a.mp3'), audioFile('b.mp3')];
    const pending = store.addFiles(picked);
    picked.length = 0; // come `input.value = ''` su un FileList vivo
    await busy;
    const result = await pending;
    expect(result.added.map((track) => track.title)).toEqual(['a', 'b']);
    expect(result.skipped).toEqual([]);
  });

  it('accepts an empty list and a FileList-like object', async () => {
    const { store } = makeStore();
    expect(await store.addFiles([])).toEqual({ added: [], skipped: [] });
    expect(await store.addFiles(null as unknown as FileList)).toEqual({ added: [], skipped: [] });
    const list = { length: 1, 0: audioFile('lista.mp3'), item: () => null };
    expect((await store.addFiles(list as unknown as FileList)).added).toHaveLength(1);
  });

  it('prefers the container duration and stops probing after repeated timeouts', async () => {
    const { store, probe, readTags } = makeStore();
    readTags.mockResolvedValueOnce({ ...emptyTags(), durationSeconds: 245.5 });
    probe.mockResolvedValue({ seconds: null, timedOut: true });
    const { added } = await store.addFiles([
      audioFile('a.m4a', { type: 'audio/mp4' }),
      audioFile('b.mp3'),
      audioFile('c.mp3'),
      audioFile('d.mp3'),
      audioFile('e.mp3'),
    ]);
    expect(added.map((track) => track.durationSeconds)).toEqual([245.5, null, null, null, null]);
    expect(probe).toHaveBeenCalledTimes(2);
    const probed = probe.mock.calls[0]?.[0];
    expect(probed?.type).toBe('audio/mpeg');
  });

  it('keeps probing after a successful read resets the timeout streak', async () => {
    const { store, probe } = makeStore();
    probe
      .mockResolvedValueOnce({ seconds: null, timedOut: true })
      .mockResolvedValueOnce({ seconds: 100, timedOut: false })
      .mockResolvedValueOnce({ seconds: null, timedOut: true })
      .mockResolvedValueOnce({ seconds: 90, timedOut: false });
    const { added } = await store.addFiles(['a', 'b', 'c', 'd'].map((n) => audioFile(`${n}.mp3`)));
    expect(added.map((track) => track.durationSeconds)).toEqual([null, 100, null, 90]);
  });

  it('survives tag readers and probes that throw', async () => {
    const { store, readTags, probe } = makeStore();
    readTags.mockRejectedValueOnce(new Error('boom'));
    probe.mockRejectedValueOnce(new Error('boom'));
    const { added } = await store.addFiles([audioFile('Band - Brano.mp3')]);
    expect(added[0]).toMatchObject({ title: 'Brano', artist: 'Band', durationSeconds: null });
  });
});

// --- Lettura, modifica, rimozione ------------------------------------------------------------

describe('library reads and removal', () => {
  it('lists newest first and drops corrupted records', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile('Primo.mp3')]);
    await store.addFiles([audioFile('Secondo.mp3')]);
    db.data.tracks.set('rotto', { id: 'rotto', title: 42 });
    db.data.tracks.set('nullo', null);
    expect((await store.listTracks()).map((track) => track.title)).toEqual(['Secondo', 'Primo']);
    expect(await store.getTrack('rotto')).toBeNull();
  });

  it('never exposes internal fields', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile('x.mp3')]);
    expect(db.data.tracks.get('id-1')).toHaveProperty('sourceKey');
    const [track] = await store.listTracks();
    expect(Object.keys(track ?? {}).sort()).toEqual(
      [
        'addedAt',
        'album',
        'artist',
        'durationSeconds',
        'hasArtwork',
        'id',
        'mimeType',
        'size',
        'title',
      ].sort(),
    );
  });

  it('returns null for unknown ids, invalid ids and non-Blob values', async () => {
    const { store, db } = makeStore();
    db.data.files.set('strano', 'non un blob');
    expect(await store.getTrackBlob('nessuno')).toBeNull();
    expect(await store.getTrackBlob('strano')).toBeNull();
    expect(await store.getTrackBlob('')).toBeNull();
    expect(await store.getArtworkBlob('x'.repeat(500))).toBeNull();
    expect(await store.getTrack('nessuno')).toBeNull();
  });

  it('removes a track from all three stores', async () => {
    const { store, db, readTags } = makeStore();
    readTags.mockResolvedValueOnce({
      ...emptyTags(),
      artwork: { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) },
    });
    await store.addFiles([audioFile('a.mp3'), audioFile('b.mp3')]);
    await store.removeTrack('id-1');
    expect(db.data.tracks.has('id-1')).toBe(false);
    expect(db.data.files.has('id-1')).toBe(false);
    expect(db.data.artwork.has('id-1')).toBe(false);
    expect((await store.listTracks()).map((track) => track.id)).toEqual(['id-2']);
    await store.removeTrack('');
    expect(db.writes).toHaveLength(3);
  });

  it('clears everything', async () => {
    const { store, db } = makeStore();
    await store.addFiles([audioFile('a.mp3'), audioFile('b.mp3')]);
    await store.clearAll();
    expect(await store.listTracks()).toEqual([]);
    expect(db.data.files.size + db.data.artwork.size).toBe(0);
  });

  it('backfills the duration once the player knows it', async () => {
    const { store, probe, db } = makeStore();
    probe.mockResolvedValue({ seconds: null, timedOut: false });
    await store.addFiles([audioFile('a.mp3')]);
    await store.setTrackDuration('id-1', 201.23456);
    expect((await store.getTrack('id-1'))?.durationSeconds).toBe(201.235);
    const writes = db.writes.length;
    await store.setTrackDuration('id-1', 201.3); // differenza trascurabile
    await store.setTrackDuration('id-1', Number.NaN);
    await store.setTrackDuration('id-1', -1);
    await store.setTrackDuration('id-1', 8 * 24 * 3600); // oltre una settimana: non plausibile
    await store.setTrackDuration('manca', 10);
    await store.setTrackDuration('', 10);
    expect(db.writes).toHaveLength(writes);
  });

  it('does not bring back a track removed while its duration is being saved', async () => {
    const { store, db, probe } = makeStore();
    probe.mockResolvedValue({ seconds: null, timedOut: false });
    await store.addFiles([audioFile('a.mp3')]);
    // Il player salva la durata (loadedmetadata) mentre l'ascoltatore elimina il brano.
    await Promise.all([store.setTrackDuration('id-1', 200), store.removeTrack('id-1')]);
    expect(await store.listTracks()).toEqual([]);
    expect(await store.getTrackBlob('id-1')).toBeNull();
    expect(db.data.tracks.has('id-1')).toBe(false);

    await store.addFiles([audioFile('b.mp3')]);
    await Promise.all([store.removeTrack('id-2'), store.setTrackDuration('id-2', 200)]);
    expect(db.data.tracks.has('id-2')).toBe(false);

    await store.addFiles([audioFile('c.mp3')]);
    await Promise.all([store.setTrackDuration('id-3', 99), store.clearAll()]);
    expect(await store.listTracks()).toEqual([]);
  });
});

// --- Spazio e persistenza --------------------------------------------------------------------

describe('usage and persistence', () => {
  it('sums audio and artwork bytes and reads the quota estimate', async () => {
    const storage: StorageManagerLike = {
      estimate: async () => ({ quota: 10_000_000, usage: 4_000_000 }),
    };
    const { store, readTags } = makeStore({ getStorage: () => storage });
    readTags.mockResolvedValueOnce({
      ...emptyTags(),
      artwork: { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) },
    });
    await store.addFiles([audioFile('a.mp3', { size: 1000 }), audioFile('b.mp3', { size: 500 })]);
    expect(await store.usage()).toEqual({
      tracks: 2,
      bytes: 1500 + JPEG.length,
      quota: 10_000_000,
      available: 6_000_000,
    });
  });

  it('reports an unknown quota without the Storage API or when the estimate fails', async () => {
    expect(await makeStore().store.usage()).toEqual({
      tracks: 0,
      bytes: 0,
      quota: null,
      available: null,
    });
    const failing = makeStore({
      getStorage: () => ({ estimate: () => Promise.reject(new Error('no')) }),
    });
    expect((await failing.store.usage()).quota).toBeNull();
    const weird = makeStore({
      getStorage: () => ({ estimate: async () => ({ quota: Number.NaN }) }),
    });
    expect((await weird.store.usage()).quota).toBeNull();
    const throwing = makeStore({
      getStorage: () => {
        throw new Error('SecurityError');
      },
    });
    expect((await throwing.store.usage()).quota).toBeNull();
  });

  it('feature-detects navigator.storage.persist', async () => {
    expect(await makeStore().store.requestPersistence()).toBe('unsupported');
    expect(await makeStore({ getStorage: () => ({}) }).store.requestPersistence()).toBe(
      'unsupported',
    );

    const persist = vi.fn(async () => true);
    const already = makeStore({ getStorage: () => ({ persisted: async () => true, persist }) });
    expect(await already.store.requestPersistence()).toBe('granted');
    expect(persist).not.toHaveBeenCalled();

    const granted = makeStore({ getStorage: () => ({ persisted: async () => false, persist }) });
    expect(await granted.store.requestPersistence()).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);

    const denied = makeStore({ getStorage: () => ({ persist: async () => false }) });
    expect(await denied.store.requestPersistence()).toBe('denied');

    const failing = makeStore({
      getStorage: () => ({ persist: () => Promise.reject(new Error('x')) }),
    });
    expect(await failing.store.requestPersistence()).toBe('denied');
  });

  it('recognises quota errors across engines', () => {
    expect(isQuotaError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new DOMException('x', 'UnknownError'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
  });
});

// --- Tipi riproducibili ----------------------------------------------------------------------

describe('resolveAudioType', () => {
  const all = () => 'maybe';
  it.each([
    ['audio/mpeg', 'a.bin', 'audio/mpeg'],
    ['AUDIO/MPEG; charset=binary', 'a', 'audio/mpeg'],
    ['audio/mp3', 'a', 'audio/mpeg'],
    ['audio/x-flac', 'a', 'audio/flac'],
    ['audio/m4a', 'a', 'audio/x-m4a'],
    ['audio/wave', 'a', 'audio/wav'],
    ['', 'Brano.FLAC', 'audio/flac'],
    ['', 'brano.opus', 'audio/ogg'],
    ['application/octet-stream', 'x.wav', 'audio/wav'],
    ['', 'senza-estensione', null],
    ['', 'a.exe', null],
    ['text/plain', 'a.mp3', null],
    ['video/mp4', 'a.m4a', null],
    // Tipi audio/* che il sistema dichiara ma la lista non conosce: decide l'estensione.
    ['audio/x-hx-aac-adts', 'senza-estensione', 'audio/aac'],
    ['audio/aac-adts', 'brano', 'audio/aac'],
    ['audio/mp4a-latm', 'brano.m4a', 'audio/mp4'],
    ['audio/x-qualcosa', 'brano.mp3', 'audio/mpeg'],
    ['audio/mp4a-latm', 'senza-estensione', null],
    ['audio/x-ms-wma', 'a.wma', null],
  ])('%s + %s → %s', (type, name, expected) => {
    expect(resolveAudioType(type, name, all)).toBe(expected);
  });

  it('tries equivalent types the browser recognises', () => {
    expect(resolveAudioType('audio/x-m4a', 'a', (m) => (m === 'audio/mp4' ? 'probably' : ''))).toBe(
      'audio/mp4',
    );
    expect(resolveAudioType('audio/wav', 'a', (m) => (m === 'audio/x-wav' ? 'maybe' : ''))).toBe(
      'audio/x-wav',
    );
    expect(resolveAudioType('audio/flac', 'a', () => '')).toBeNull();
    expect(resolveAudioType('audio/mp4a-latm', 'a.m4a', () => '')).toBeNull();
    expect(
      resolveAudioType('audio/mpeg', 'a', () => {
        throw new Error('x');
      }),
    ).toBeNull();
  });

  it('returns no support outside the browser', () => {
    expect(browserCanPlayType('audio/mpeg')).toBe('');
  });
});

// --- Durata ----------------------------------------------------------------------------------

class FakeAudio extends EventTarget {
  preload = '';
  muted = false;
  src = '';
  duration = Number.NaN;
  loads = 0;
  removed: string[] = [];
  load() {
    this.loads += 1;
  }
  removeAttribute(name: string) {
    this.removed.push(name);
    if (name === 'src') this.src = '';
  }
}

function fakeUrls() {
  return {
    createObjectURL: vi.fn((_blob: Blob) => 'blob:solco/1'),
    revokeObjectURL: vi.fn((_url: string) => undefined),
  };
}

describe('probeDuration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the duration from loadedmetadata and cleans up', async () => {
    const audio = new FakeAudio();
    const urlApi = fakeUrls();
    const pending = probeDuration(new Blob(['x']), {
      createAudio: () => audio as unknown as ProbeAudioElement,
      urlApi,
    });
    expect(audio.src).toBe('blob:solco/1');
    expect(audio.preload).toBe('metadata');
    expect(audio.muted).toBe(true);
    audio.duration = 123.45678;
    audio.dispatchEvent(new Event('loadedmetadata'));
    expect(await pending).toEqual({ seconds: 123.457, timedOut: false });
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:solco/1');
    expect(audio.removed).toContain('src');
    expect(audio.loads).toBe(2);
  });

  it('returns null for infinite durations and media errors', async () => {
    const live = new FakeAudio();
    const first = probeDuration(new Blob(['x']), {
      createAudio: () => live as unknown as ProbeAudioElement,
      urlApi: fakeUrls(),
    });
    live.duration = Number.POSITIVE_INFINITY;
    live.dispatchEvent(new Event('loadedmetadata'));
    expect(await first).toEqual({ seconds: null, timedOut: false });

    const broken = new FakeAudio();
    const urlApi = fakeUrls();
    const second = probeDuration(new Blob(['x']), {
      createAudio: () => broken as unknown as ProbeAudioElement,
      urlApi,
    });
    broken.dispatchEvent(new Event('error'));
    expect(await second).toEqual({ seconds: null, timedOut: false });
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('gives up after 5 seconds', async () => {
    vi.useFakeTimers();
    const urlApi = fakeUrls();
    const audio = new FakeAudio();
    const pending = probeDuration(new Blob(['x']), {
      createAudio: () => audio as unknown as ProbeAudioElement,
      urlApi,
    });
    vi.advanceTimersByTime(DURATION_PROBE_TIMEOUT_MS);
    expect(await pending).toEqual({ seconds: null, timedOut: true });
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
    // Un evento in ritardo non cambia nulla.
    audio.duration = 50;
    audio.dispatchEvent(new Event('loadedmetadata'));
  });

  it('returns null when object URLs or the audio element are unavailable', async () => {
    expect(
      await probeDuration(new Blob(['x']), {
        urlApi: {
          createObjectURL: () => {
            throw new Error('no');
          },
          revokeObjectURL: () => undefined,
        },
        createAudio: () => new FakeAudio() as unknown as ProbeAudioElement,
      }),
    ).toEqual({ seconds: null, timedOut: false });
    expect(
      await probeDuration(new Blob(['x']), {
        urlApi: fakeUrls(),
        createAudio: () => {
          throw new Error('Audio is not defined');
        },
      }),
    ).toEqual({ seconds: null, timedOut: false });
  });
});

// --- Object URL per il player ----------------------------------------------------------------

describe('object URLs for playback', () => {
  it('creates an object URL for a stored track and revokes it once', async () => {
    const { store } = makeStore();
    await store.addFiles([audioFile('a.mp3')]);
    const urlApi = fakeUrls();
    const handle = await createObjectUrlForTrack('id-1', { store, urlApi });
    expect(handle?.url).toBe('blob:solco/1');
    const blob = urlApi.createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe('audio/mpeg');
    handle?.revoke();
    handle?.revoke();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('returns null for a missing track or artwork', async () => {
    const { store } = makeStore();
    const urlApi = fakeUrls();
    expect(await createObjectUrlForTrack('manca', { store, urlApi })).toBeNull();
    expect(await createObjectUrlForArtwork('manca', { store, urlApi })).toBeNull();
    expect(urlApi.createObjectURL).not.toHaveBeenCalled();
  });

  it('creates artwork URLs too and tolerates a failing revoke', async () => {
    const { store, readTags } = makeStore();
    readTags.mockResolvedValueOnce({
      ...emptyTags(),
      artwork: { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) },
    });
    await store.addFiles([audioFile('a.mp3')]);
    const urlApi = fakeUrls();
    urlApi.revokeObjectURL.mockImplementation(() => {
      throw new Error('già revocato');
    });
    const handle = await createObjectUrlForArtwork('id-1', { store, urlApi });
    expect(handle).not.toBeNull();
    expect(() => handle?.revoke()).not.toThrow();
  });

  it('wraps any Blob', () => {
    const urlApi = fakeUrls();
    const handle = objectUrlHandle(new Blob(['x']), urlApi);
    expect(handle.url).toBe('blob:solco/1');
    handle.revoke();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:solco/1');
  });
});

describe('bundle del player', () => {
  /** Local-music modules reached from `start` by value imports/re-exports (types are erased). */
  function reachable(start: string): Set<string> {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const name = pending.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const source = readFileSync(
        resolve(process.cwd(), `src/lib/local-music/${name}.ts`),
        'utf-8',
      );
      const statements = source.matchAll(
        /^(?:import|export)\s+(?!type\b)[^;]*?from\s+'@\/lib\/local-music\/([\w-]+)'/gms,
      );
      for (const [, next] of statements) if (next) pending.push(next);
    }
    return seen;
  }

  it('playback.ts (che il player importa) non porta con sé aggiunta e lettori di tag', () => {
    const modules = reachable('playback');
    expect(modules.has('reader')).toBe(true);
    for (const heavy of ['store', 'tags', 'id3', 'mp4', 'media']) {
      expect(modules.has(heavy), heavy).toBe(false);
    }
    const player = readFileSync(
      resolve(process.cwd(), 'src/components/custom/music/music-player.tsx'),
      'utf-8',
    );
    expect(player).toContain("from '@/lib/local-music/playback'");
    expect(player).not.toMatch(/from '@\/lib\/local-music'/);
  });
});
