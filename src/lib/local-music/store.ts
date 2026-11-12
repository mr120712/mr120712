// @polsia:user-owned — libreria sul dispositivo: aggiunta, elenco e rimozione dei file audio.
//
// Design legale: i file NON lasciano mai il dispositivo. Qui non c'è nessuna rete: ogni byte va
// da un File scelto dall'ascoltatore a IndexedDB nel suo browser e da lì al player con un object
// URL (playback.ts). I brani locali non contano mai per gli ascolti del piano Free.
//
// addFiles elabora i file uno alla volta (memoria limitata, avanzamento leggibile): tipo
// riproducibile dal browser, massimo 200 MiB, niente duplicati (stesso nome + dimensione + data di
// modifica), tag letti a pezzi (tags.ts), durata dal contenitore o da un elemento Audio, poi
// un'unica transazione su 'tracks' + 'files' + 'artwork'. Lo spazio esaurito (QuotaExceededError)
// salta quel file con motivo 'quota' e il lotto prosegue: i file più piccoli possono ancora
// entrare. Le chiamate ad addFiles sono messe in fila, così due lotti paralleli non si duplicano;
// l'elenco dei file però si copia subito, perché il FileList di <input type=file> è vivo e si
// svuota con `input.value = ''`. Su iOS WebKit a volte non riesce a salvare un Blob che punta al
// file scelto ("Error preparing Blob/File data…"): un errore che non è di spazio si riprova una
// volta con una copia in memoria, solo per file fino a 50 MiB.
//
// Lo spazio è "best effort": Safari cancella i dati di un sito non usato per 7 giorni se non è
// sulla schermata Home, e ogni browser può liberarlo sotto pressione. requestPersistence chiede al
// browser di non farlo (navigator.storage.persist, dove esiste).

import type { LocalMusicDb, LocalMusicWrite } from '@/lib/local-music/idb';
import {
  browserCanPlayType,
  type CanPlayType,
  type DurationProbe,
  probeDuration,
  resolveAudioType,
} from '@/lib/local-music/media';
import {
  createLocalMusicReader,
  defaultLocalMusicDb,
  finiteNumber,
  isValidId,
  type LocalMusicReader,
  readStoredTrack,
  type StoredTrack,
  toPublic,
} from '@/lib/local-music/reader';
import { sanitizeTagText } from '@/lib/local-music/tag-utils';
import { readAudioTags, tagsFromFileName } from '@/lib/local-music/tags';
import {
  type AddFilesOptions,
  type AddFilesResult,
  type AudioTags,
  type DownloadedTrackSource,
  emptyTags,
  type LocalMusicUsage,
  type LocalSkipReason,
  type LocalTrack,
  type LocalTrackAttribution,
  MAX_LOCAL_FILE_BYTES,
  type PersistenceResult,
} from '@/lib/local-music/types';

/** Il minimo di un File che serve per aggiungerlo (un File del browser va benissimo). */
export type LocalFileInput = Pick<File, 'name' | 'size' | 'type' | 'lastModified' | 'slice'>;

export type StorageManagerLike = {
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
};

export type LocalMusicStoreDeps = {
  db: LocalMusicDb;
  canPlayType: CanPlayType;
  readTags: (blob: Blob) => Promise<AudioTags>;
  probeDuration: (blob: Blob) => Promise<DurationProbe>;
  getStorage: () => StorageManagerLike | null | undefined;
  now: () => number;
  randomId: () => string;
};

/**
 * Un brano scaricato ("Scarica il permesso") già in memoria, da salvare nella libreria con la sua
 * attribuzione. Passa dalla stessa validazione/quota/anti-duplicato dei file locali.
 */
export type DownloadedTrackInput = {
  /** Audio scaricato, con il tipo dichiarato dalla fonte. */
  blob: Blob;
  /** Chiave stabile anti-duplicato della fonte (es. l'id Audius o 'podcastId~episodeKey'). */
  downloadKey: string;
  source: DownloadedTrackSource;
  title: string;
  artist: string | null;
  album: string | null;
  durationSeconds: number | null;
  /** Tipo audio dichiarato dalla fonte; normalizzato e verificato come i file locali. */
  mimeType: string;
  attribution: LocalTrackAttribution;
  /** Copertina già scaricata (facoltativa). */
  artwork?: Blob | null;
};

export type AddDownloadedResult =
  | { ok: true; track: LocalTrack }
  | { ok: false; reason: LocalSkipReason };

/** Le letture (getTrack, Blob, copertina, durata) vengono da reader.ts, che usa anche il player. */
export type LocalMusicStore = LocalMusicReader & {
  addFiles(
    files: FileList | ArrayLike<LocalFileInput> | Iterable<LocalFileInput>,
    options?: AddFilesOptions,
  ): Promise<AddFilesResult>;
  /** Salva un brano scaricato (Audius/podcast) nella libreria sul dispositivo. */
  addDownloadedTrack(input: DownloadedTrackInput): Promise<AddDownloadedResult>;
  listTracks(): Promise<LocalTrack[]>;
  removeTrack(id: string): Promise<void>;
  clearAll(): Promise<void>;
  usage(): Promise<LocalMusicUsage>;
  requestPersistence(): Promise<PersistenceResult>;
};

/** Dopo tanti timeout di fila la lettura della durata si salta per il resto del lotto. */
const MAX_CONSECUTIVE_PROBE_TIMEOUTS = 2;
/** Oltre questa dimensione un salvataggio fallito non si riprova con una copia in memoria. */
export const MAX_IN_MEMORY_RETRY_BYTES = 50 * 1024 * 1024;

/** Più recenti prima; a parità, in ordine di titolo. */
function compareTracks(a: LocalTrack, b: LocalTrack): number {
  return b.addedAt - a.addedAt || a.title.localeCompare(b.title);
}

function sourceKeyFor(file: LocalFileInput): string {
  return JSON.stringify([String(file.name), file.size, file.lastModified ?? 0]);
}

/**
 * Chiave anti-duplicato di un download: il primo elemento è la stringa 'download', il secondo la
 * fonte, così non può mai coincidere con la chiave di un file locale ([nome, dimensione, data]).
 */
function downloadSourceKey(source: DownloadedTrackSource, downloadKey: string): string {
  return JSON.stringify(['download', source, downloadKey]);
}

/** Scritture (audio + copertina + metadati) di un brano in un'unica transazione. */
function trackWrites(record: StoredTrack, audio: Blob, artwork: Blob | null): LocalMusicWrite[] {
  const writes: LocalMusicWrite[] = [{ op: 'put', store: 'files', key: record.id, value: audio }];
  if (artwork) writes.push({ op: 'put', store: 'artwork', key: record.id, value: artwork });
  writes.push({ op: 'put', store: 'tracks', key: record.id, value: record });
  return writes;
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

function defaultRandomId(): string {
  const cryptoApi = typeof crypto === 'undefined' ? undefined : crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultDeps(): LocalMusicStoreDeps {
  return {
    db: defaultLocalMusicDb(),
    canPlayType: browserCanPlayType,
    readTags: readAudioTags,
    probeDuration: (blob) => probeDuration(blob),
    getStorage: () =>
      typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageManagerLike),
    now: () => Date.now(),
    randomId: defaultRandomId,
  };
}

type AddOutcome = { track: LocalTrack } | { reason: LocalSkipReason };

/** Crea la libreria; nei test si iniettano database, browser e orologio finti. */
export function createLocalMusicStore(
  overrides: Partial<LocalMusicStoreDeps> = {},
): LocalMusicStore {
  const deps: LocalMusicStoreDeps = { ...defaultDeps(), ...overrides };
  const reader = createLocalMusicReader(deps.db);
  let addQueue: Promise<unknown> = Promise.resolve();

  async function loadRecords(): Promise<StoredTrack[]> {
    const rows = await deps.db.getAll('tracks');
    const records: StoredTrack[] = [];
    for (const row of rows) {
      const record = readStoredTrack(row);
      if (record) records.push(record);
    }
    return records;
  }

  async function safeTags(blob: Blob): Promise<AudioTags> {
    try {
      return await deps.readTags(blob);
    } catch {
      return emptyTags();
    }
  }

  async function safeProbe(blob: Blob): Promise<DurationProbe> {
    try {
      return await deps.probeDuration(blob);
    } catch {
      return { seconds: null, timedOut: false };
    }
  }

  async function addOne(
    file: LocalFileInput,
    known: Set<string>,
    probe: { timeouts: number },
  ): Promise<AddOutcome> {
    const name = typeof file.name === 'string' ? file.name : '';
    const mimeType = resolveAudioType(file.type, name, deps.canPlayType);
    if (!mimeType || !finiteNumber(file.size) || file.size <= 0) return { reason: 'unsupported' };
    if (file.size > MAX_LOCAL_FILE_BYTES) return { reason: 'too_large' };
    const sourceKey = sourceKeyFor(file);
    if (known.has(sourceKey)) return { reason: 'duplicate' };

    // Blob con il tipo giusto: Safari riproduce un object URL solo se il tipo è noto.
    const audio = file.slice(0, file.size, mimeType);
    const tags = await safeTags(audio);
    const fromName = tagsFromFileName(name);
    let durationSeconds = tags.durationSeconds;
    if (durationSeconds === null && probe.timeouts < MAX_CONSECUTIVE_PROBE_TIMEOUTS) {
      const result = await safeProbe(audio);
      durationSeconds = result.seconds;
      probe.timeouts = result.timedOut ? probe.timeouts + 1 : 0;
    }

    const artwork = tags.artwork
      ? new Blob([tags.artwork.bytes], { type: tags.artwork.mimeType })
      : null;
    const record: StoredTrack = {
      id: deps.randomId(),
      title: tags.title ?? fromName.title,
      artist: tags.title ? tags.artist : (tags.artist ?? fromName.artist),
      album: tags.album,
      durationSeconds,
      mimeType,
      size: file.size,
      addedAt: deps.now(),
      hasArtwork: artwork !== null,
      sourceKey,
      fileName: sanitizeTagText(name) ?? '',
      artworkBytes: artwork ? artwork.size : 0,
      source: 'local',
      attribution: null,
    };

    const reason = await persistRecord(record, audio, artwork);
    if (reason) return { reason };
    known.add(sourceKey);
    return { track: toPublic(record) };
  }

  /**
   * Scrive il brano in un'unica transazione. Lo spazio esaurito (QuotaExceededError) torna 'quota',
   * un guasto imprevisto 'error'; per i Blob legati a un file (WebKit) si riprova una volta con una
   * copia in memoria, solo fino a 50 MiB. Null se la scrittura è andata a buon fine.
   */
  async function persistRecord(
    record: StoredTrack,
    audio: Blob,
    artwork: Blob | null,
  ): Promise<LocalSkipReason | null> {
    try {
      await deps.db.write(trackWrites(record, audio, artwork));
      return null;
    } catch (error) {
      if (isQuotaError(error) || record.size > MAX_IN_MEMORY_RETRY_BYTES) {
        return isQuotaError(error) ? 'quota' : 'error';
      }
      try {
        const copy = new Blob([await audio.arrayBuffer()], { type: record.mimeType });
        await deps.db.write(trackWrites(record, copy, artwork));
      } catch (retryError) {
        return isQuotaError(retryError) ? 'quota' : 'error';
      }
      return null;
    }
  }

  /** Salva un brano scaricato: stessa validazione/quota/anti-duplicato dei file locali. */
  async function runAddDownloaded(input: DownloadedTrackInput): Promise<AddDownloadedResult> {
    const size = input.blob.size;
    const mimeType = resolveAudioType(input.mimeType, input.title, deps.canPlayType);
    if (!mimeType || !finiteNumber(size) || size <= 0) return { ok: false, reason: 'unsupported' };
    if (size > MAX_LOCAL_FILE_BYTES) return { ok: false, reason: 'too_large' };

    const sourceKey = downloadSourceKey(input.source, input.downloadKey);
    const known = new Set((await loadRecords()).map((row) => row.sourceKey));
    if (known.has(sourceKey)) return { ok: false, reason: 'duplicate' };

    // Blob con il tipo normalizzato: Safari riproduce un object URL solo se il tipo è noto.
    const audio = input.blob.type === mimeType ? input.blob : input.blob.slice(0, size, mimeType);
    const artwork = input.artwork && input.artwork.size > 0 ? input.artwork : null;

    let durationSeconds = finiteNumber(input.durationSeconds) ? input.durationSeconds : null;
    if (durationSeconds === null) {
      durationSeconds = (await safeProbe(audio)).seconds;
    }

    const title = sanitizeTagText(input.title) ?? 'Senza titolo';
    const record: StoredTrack = {
      id: deps.randomId(),
      title,
      artist: sanitizeTagText(input.artist),
      album: sanitizeTagText(input.album),
      durationSeconds,
      mimeType,
      size,
      addedAt: deps.now(),
      hasArtwork: artwork !== null,
      sourceKey,
      fileName: title,
      artworkBytes: artwork ? artwork.size : 0,
      source: input.source,
      attribution: input.attribution,
    };

    const reason = await persistRecord(record, audio, artwork);
    if (reason) return { ok: false, reason };
    return { ok: true, track: toPublic(record) };
  }

  async function runAddFiles(
    files: readonly (LocalFileInput | undefined)[],
    options: AddFilesOptions,
  ): Promise<AddFilesResult> {
    const result: AddFilesResult = { added: [], skipped: [] };
    if (files.length === 0) return result;

    // Se il database non si apre, l'errore arriva al chiamante (libreria non disponibile).
    const known = new Set((await loadRecords()).map((record) => record.sourceKey));
    const probe = { timeouts: 0 };

    for (const [index, file] of files.entries()) {
      const displayName = sanitizeTagText(file?.name) ?? 'file senza nome';
      let outcome: AddOutcome;
      try {
        outcome = file ? await addOne(file, known, probe) : { reason: 'unsupported' };
      } catch {
        outcome = { reason: 'error' };
      }
      if ('track' in outcome) result.added.push(outcome.track);
      else result.skipped.push({ name: displayName, reason: outcome.reason });
      try {
        options.onProgress?.({ processed: index + 1, total: files.length, fileName: displayName });
      } catch {
        // Un errore della UI non interrompe l'importazione.
      }
    }
    return result;
  }

  return {
    addFiles(files, options = {}) {
      // Copia sincrona: il FileList di un <input type=file> si svuota con `input.value = ''`, e il
      // lotto può partire solo dopo quelli già in fila.
      let list: (LocalFileInput | undefined)[];
      try {
        list = Array.from((files ?? []) as ArrayLike<LocalFileInput | undefined>);
      } catch (error) {
        return Promise.reject(error);
      }
      const run = addQueue.then(() => runAddFiles(list, options));
      addQueue = run.catch(() => undefined);
      return run;
    },

    addDownloadedTrack(input) {
      // In fila come addFiles: due download dello stesso brano non si duplicano a vicenda.
      const run = addQueue.then(() => runAddDownloaded(input));
      addQueue = run.catch(() => undefined);
      return run;
    },

    async listTracks() {
      return (await loadRecords()).map(toPublic).sort(compareTracks);
    },

    getTrack: reader.getTrack,
    getTrackBlob: reader.getTrackBlob,
    getArtworkBlob: reader.getArtworkBlob,
    setTrackDuration: reader.setTrackDuration,

    async removeTrack(id) {
      if (!isValidId(id)) return;
      await deps.db.write([
        { op: 'delete', store: 'tracks', key: id },
        { op: 'delete', store: 'files', key: id },
        { op: 'delete', store: 'artwork', key: id },
      ]);
    },

    async clearAll() {
      await deps.db.clear(['tracks', 'files', 'artwork']);
    },

    async usage() {
      const records = await loadRecords();
      const bytes = records.reduce((sum, record) => sum + record.size + record.artworkBytes, 0);
      let quota: number | null = null;
      let available: number | null = null;
      try {
        const storage = deps.getStorage();
        if (storage && typeof storage.estimate === 'function') {
          const estimate = await storage.estimate();
          if (finiteNumber(estimate?.quota) && estimate.quota > 0) {
            quota = estimate.quota;
            if (finiteNumber(estimate.usage)) available = Math.max(0, quota - estimate.usage);
          }
        }
      } catch {
        // Stima non disponibile: quota ignota.
      }
      return { tracks: records.length, bytes, quota, available };
    },

    async requestPersistence() {
      let storage: StorageManagerLike | null | undefined;
      try {
        storage = deps.getStorage();
      } catch {
        storage = undefined;
      }
      if (!storage || typeof storage.persist !== 'function') return 'unsupported';
      try {
        if (typeof storage.persisted === 'function' && (await storage.persisted())) {
          return 'granted';
        }
        return (await storage.persist()) ? 'granted' : 'denied';
      } catch {
        return 'denied';
      }
    },
  };
}

let defaultStore: LocalMusicStore | null = null;

/** La libreria del browser (IndexedDB vero), creata alla prima chiamata. */
export function getLocalMusicStore(): LocalMusicStore {
  if (!defaultStore) defaultStore = createLocalMusicStore();
  return defaultStore;
}

export function addFiles(
  files: FileList | ArrayLike<LocalFileInput> | Iterable<LocalFileInput>,
  options?: AddFilesOptions,
): Promise<AddFilesResult> {
  return getLocalMusicStore().addFiles(files, options);
}

export function addDownloadedTrack(input: DownloadedTrackInput): Promise<AddDownloadedResult> {
  return getLocalMusicStore().addDownloadedTrack(input);
}

export function listTracks(): Promise<LocalTrack[]> {
  return getLocalMusicStore().listTracks();
}

export function removeTrack(id: string): Promise<void> {
  return getLocalMusicStore().removeTrack(id);
}

export function clearAll(): Promise<void> {
  return getLocalMusicStore().clearAll();
}

export function usage(): Promise<LocalMusicUsage> {
  return getLocalMusicStore().usage();
}

export function requestPersistence(): Promise<PersistenceResult> {
  return getLocalMusicStore().requestPersistence();
}

/** True se il browser ha quanto serve per la libreria locale (IndexedDB, Blob, object URL). */
export function isLocalMusicSupported(): boolean {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}
