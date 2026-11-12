// @polsia:user-owned — lettura della libreria sul dispositivo, senza il codice che aggiunge i file.
//
// Il player è in ogni pagina e importa solo questo modulo (tramite playback.ts): brano, Blob audio,
// copertina e la durata da completare. L'aggiunta dei file, con i lettori di tag ID3/MP4
// (store.ts → tags.ts), resta nel modulo che importa solo la sezione "La tua musica", così quel
// codice non entra nel bundle di ogni pagina. Nessuna rete: solo IndexedDB nel browser.

import { createIndexedDbAdapter, type LocalMusicDb } from '@/lib/local-music/idb';
import { plausibleDuration } from '@/lib/local-music/tag-utils';
import type { LocalTrack } from '@/lib/local-music/types';

/** Record salvato in 'tracks': il LocalTrack pubblico più i campi interni. */
export type StoredTrack = LocalTrack & {
  /** Chiave anti-duplicato: nome + dimensione + data di modifica del file originale. */
  sourceKey: string;
  fileName: string;
  artworkBytes: number;
};

export type LocalMusicReader = {
  getTrack(id: string): Promise<LocalTrack | null>;
  getTrackBlob(id: string): Promise<Blob | null>;
  getArtworkBlob(id: string): Promise<Blob | null>;
  /** Completa la durata quando il player la conosce (es. su iOS, dove la lettura all'aggiunta fallisce). */
  setTrackDuration(id: string, seconds: number): Promise<void>;
};

const MAX_ID_LENGTH = 128;

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH;
}

function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Blob).size === 'number' &&
    typeof (value as Blob).slice === 'function'
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Record letto da IndexedDB, controllato (dati di versioni future o rovinati vengono scartati). */
export function readStoredTrack(value: unknown): StoredTrack | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isValidId(r.id) || typeof r.title !== 'string' || r.title.length === 0) return null;
  if (!nullableString(r.artist) || !nullableString(r.album)) return null;
  if (!(r.durationSeconds === null || finiteNumber(r.durationSeconds))) return null;
  if (typeof r.mimeType !== 'string' || !finiteNumber(r.size) || !finiteNumber(r.addedAt)) {
    return null;
  }
  if (typeof r.hasArtwork !== 'boolean' || typeof r.sourceKey !== 'string') return null;
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    durationSeconds: r.durationSeconds,
    mimeType: r.mimeType,
    size: r.size,
    addedAt: r.addedAt,
    hasArtwork: r.hasArtwork,
    sourceKey: r.sourceKey,
    fileName: typeof r.fileName === 'string' ? r.fileName : '',
    artworkBytes: finiteNumber(r.artworkBytes) ? r.artworkBytes : 0,
  };
}

export function toPublic(record: StoredTrack): LocalTrack {
  return {
    id: record.id,
    title: record.title,
    artist: record.artist,
    album: record.album,
    durationSeconds: record.durationSeconds,
    mimeType: record.mimeType,
    size: record.size,
    addedAt: record.addedAt,
    hasArtwork: record.hasArtwork,
  };
}

/** Letture della libreria su un database dato (nei test, uno finto). */
export function createLocalMusicReader(db: LocalMusicDb): LocalMusicReader {
  return {
    async getTrack(id) {
      if (!isValidId(id)) return null;
      const record = readStoredTrack(await db.get('tracks', id));
      return record ? toPublic(record) : null;
    },

    async getTrackBlob(id) {
      if (!isValidId(id)) return null;
      const value = await db.get('files', id);
      return isBlobLike(value) ? value : null;
    },

    async getArtworkBlob(id) {
      if (!isValidId(id)) return null;
      const value = await db.get('artwork', id);
      return isBlobLike(value) ? value : null;
    },

    async setTrackDuration(id, seconds) {
      if (!isValidId(id) || !finiteNumber(seconds)) return;
      const duration = plausibleDuration(seconds);
      if (duration === null) return;
      // Lettura e scrittura nella stessa transazione: un brano rimosso nel frattempo non ricompare.
      await db.update('tracks', id, (current) => {
        const record = readStoredTrack(current);
        if (!record) return undefined;
        if (record.durationSeconds !== null && Math.abs(record.durationSeconds - duration) < 0.5) {
          return undefined;
        }
        return { ...record, durationSeconds: duration };
      });
    },
  };
}

let sharedDb: LocalMusicDb | null = null;

/** La connessione IndexedDB del browser, una sola per lettura e aggiunta (aperta al primo uso). */
export function defaultLocalMusicDb(): LocalMusicDb {
  if (!sharedDb) sharedDb = createIndexedDbAdapter();
  return sharedDb;
}

let defaultReader: LocalMusicReader | null = null;

/** Le letture sulla libreria del browser (IndexedDB vero), create alla prima chiamata. */
export function getLocalMusicReader(): LocalMusicReader {
  if (!defaultReader) defaultReader = createLocalMusicReader(defaultLocalMusicDb());
  return defaultReader;
}

export function getTrack(id: string): Promise<LocalTrack | null> {
  return getLocalMusicReader().getTrack(id);
}

export function getTrackBlob(id: string): Promise<Blob | null> {
  return getLocalMusicReader().getTrackBlob(id);
}

export function getArtworkBlob(id: string): Promise<Blob | null> {
  return getLocalMusicReader().getArtworkBlob(id);
}

export function setTrackDuration(id: string, seconds: number): Promise<void> {
  return getLocalMusicReader().setTrackDuration(id, seconds);
}
