// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { LocalMusicDb, LocalMusicStoreName, LocalMusicWrite } from '@/lib/local-music/idb';
import type { DurationProbe } from '@/lib/local-music/media';
import { createLocalMusicStore, type LocalMusicStoreDeps } from '@/lib/local-music/store';
import { type AudioTags, emptyTags, MAX_LOCAL_FILE_BYTES } from '@/lib/local-music/types';

class MemoryDb implements LocalMusicDb {
  data: Record<LocalMusicStoreName, Map<string, unknown>> = {
    tracks: new Map(),
    files: new Map(),
    artwork: new Map(),
  };
  failWrite: ((ops: readonly LocalMusicWrite[]) => unknown) | null = null;

  async get(store: LocalMusicStoreName, key: string) {
    return this.data[store].get(key);
  }
  async getAll(store: LocalMusicStoreName) {
    return [...this.data[store].values()];
  }
  async write(ops: readonly LocalMusicWrite[]) {
    const error = this.failWrite?.(ops);
    if (error) throw error;
    for (const op of ops) {
      if (op.op === 'put') this.data[op.store].set(op.key, op.value);
      else this.data[op.store].delete(op.key);
    }
  }
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
  return { store, db, probe };
}

const attribution = {
  sourceName: 'Audius',
  sourceUrl: 'https://audius.co/artista/brano',
  licenseName: 'Audius Open Music License',
  licenseUrl: 'https://openaudiofoundation.org/open-music-license.pdf',
  creditLine: '© Artista',
};

function download(overrides: Record<string, unknown> = {}) {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }),
    downloadKey: 'audius:trk-1',
    source: 'audius-download' as const,
    title: 'Brano aperto',
    artist: 'Artista',
    album: null,
    durationSeconds: 240,
    mimeType: 'audio/mpeg',
    attribution,
    ...overrides,
  };
}

function audioFile(name: string, { size = 1000, type = 'audio/mpeg', lastModified = 1 } = {}) {
  return new File([new Uint8Array(size)], name, { type, lastModified });
}

describe('addDownloadedTrack', () => {
  it('salva un brano scaricato con fonte e attribuzione, leggibili da list e get', async () => {
    const { store, db } = makeStore();
    const result = await store.addDownloadedTrack(download());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('attesa aggiunta riuscita');
    expect(result.track).toMatchObject({
      id: 'id-1',
      title: 'Brano aperto',
      artist: 'Artista',
      album: null,
      durationSeconds: 240,
      mimeType: 'audio/mpeg',
      hasArtwork: false,
      source: 'audius-download',
      attribution,
    });

    expect(db.data.files.has('id-1')).toBe(true);
    expect(db.data.tracks.has('id-1')).toBe(true);
    expect(db.data.artwork.has('id-1')).toBe(false);
    const [track] = await store.listTracks();
    expect(track).toMatchObject({ id: 'id-1', source: 'audius-download', attribution });
    expect(await store.getTrack('id-1')).toMatchObject({ source: 'audius-download', attribution });
    const audio = await store.getTrackBlob('id-1');
    expect(audio?.type).toBe('audio/mpeg');
  });

  it('salva anche la copertina quando fornita', async () => {
    const { store, db } = makeStore();
    const art = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' });
    const result = await store.addDownloadedTrack(download({ artwork: art }));
    expect(result.ok).toBe(true);
    expect(db.data.artwork.get('id-1')).toBeInstanceOf(Blob);
    expect((await store.listTracks())[0]?.hasArtwork).toBe(true);
  });

  it('usa la durata fornita e sonda solo quando manca', async () => {
    const provided = makeStore();
    await provided.store.addDownloadedTrack(download({ durationSeconds: 321 }));
    expect((await provided.store.getTrack('id-1'))?.durationSeconds).toBe(321);
    expect(provided.probe).not.toHaveBeenCalled();

    const missing = makeStore();
    await missing.store.addDownloadedTrack(download({ durationSeconds: null }));
    expect((await missing.store.getTrack('id-1'))?.durationSeconds).toBe(180);
    expect(missing.probe).toHaveBeenCalledTimes(1);
  });

  it('non duplica lo stesso download (stessa fonte + chiave)', async () => {
    const { store } = makeStore();
    expect((await store.addDownloadedTrack(download())).ok).toBe(true);
    expect(await store.addDownloadedTrack(download())).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('distingue la stessa chiave su fonti diverse e convive con i file locali', async () => {
    const { store } = makeStore();
    const a = await store.addDownloadedTrack(
      download({ downloadKey: 'k', source: 'audius-download' }),
    );
    const b = await store.addDownloadedTrack(
      download({ downloadKey: 'k', source: 'podcast-download' }),
    );
    await store.addFiles([audioFile('locale.mp3')]);
    expect(a.ok && b.ok).toBe(true);
    const tracks = await store.listTracks();
    expect(tracks).toHaveLength(3);
    // Il file locale non espone fonte/attribuzione; i download sì.
    const local = tracks.find((t) => t.title === 'locale');
    expect(local?.source).toBeUndefined();
    expect(local?.attribution).toBeUndefined();
    expect(tracks.filter((t) => t.source === 'audius-download')).toHaveLength(1);
    expect(tracks.filter((t) => t.source === 'podcast-download')).toHaveLength(1);
  });

  it('rifiuta un tipo audio non riproducibile', async () => {
    const { store } = makeStore();
    expect(await store.addDownloadedTrack(download({ mimeType: 'application/pdf' }))).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('rifiuta un brano oltre il limite per file', async () => {
    const { store } = makeStore();
    const big = download();
    Object.defineProperty(big.blob, 'size', { value: MAX_LOCAL_FILE_BYTES + 1 });
    expect(await store.addDownloadedTrack(big)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('segnala lo spazio esaurito come quota', async () => {
    const { store, db } = makeStore();
    db.failWrite = () => new DOMException('Spazio esaurito', 'QuotaExceededError');
    expect(await store.addDownloadedTrack(download())).toEqual({ ok: false, reason: 'quota' });
  });

  it('rimuove un brano scaricato da tutti gli store', async () => {
    const { store, db } = makeStore();
    await store.addDownloadedTrack(download({ artwork: new Blob([new Uint8Array([1])]) }));
    await store.removeTrack('id-1');
    expect(db.data.tracks.has('id-1')).toBe(false);
    expect(db.data.files.has('id-1')).toBe(false);
    expect(db.data.artwork.has('id-1')).toBe(false);
    expect(await store.listTracks()).toEqual([]);
  });
});
