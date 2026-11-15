// @polsia:user-owned — lettura della libreria sul dispositivo, senza il codice che aggiunge i file.
//
// Il player è in ogni pagina e importa solo questo modulo (tramite playback.ts): brano, Blob audio,
// copertina e la durata da completare. L'aggiunta dei file, con i lettori di tag ID3/MP4
// (store.ts → tags.ts), resta nel modulo che importa solo la sezione "La tua musica", così quel
// codice non entra nel bundle di ogni pagina. Nessuna rete: solo IndexedDB nel browser.
//
// Il record su disco è la fonte di verità di CHE COS'È un brano: la fonte ('local' o un download)
// si rilegge e si riscrive tale e quale, e la copia offline di un "brano in evidenza" si riconosce
// anche dalla sua chiave esatta (download-key.ts) quando un record più vecchio ha perso la fonte.
// Così una copia non diventa mai un file dell'ascoltatore, nemmeno se il registro delle copie in
// localStorage (featured-offline-copies) va perso. Quella regola della chiave è PERMANENTE: non va
// tolta nemmeno dopo la riparazione sul disco (store.ts, repairFeaturedCopySources), perché una
// scheda rimasta aperta con la versione precedente può ancora riscrivere un record come 'local'.
//
// Per lo stesso motivo un record che ha la chiave di un download di una fonte SCONOSCIUTA a questa
// versione (scritto da una più recente) non si legge affatto: non è un file dell'ascoltatore, e
// rileggerlo come 'local' per poi riscriverlo è esattamente il guasto capitato a
// 'featured-download'. E una riscrittura (setTrackDuration) cambia solo ciò che deve: gli altri
// campi del record, anche quelli che questa versione non conosce, restano com'erano.

import {
  isFeaturedCopySourceKey,
  isUnknownDownloadSourceKey,
  readDownloadSourceKey,
} from '@/lib/local-music/download-key';
import {
  createIndexedDbAdapter,
  type LocalMusicDb,
  localMusicDbExists,
} from '@/lib/local-music/idb';
import { plausibleDuration } from '@/lib/local-music/tag-utils';
import type {
  DownloadedTrackSource,
  LocalTrack,
  LocalTrackAttribution,
  LocalTrackSource,
} from '@/lib/local-music/types';

/** Record salvato in 'tracks': il LocalTrack pubblico più i campi interni. */
export type StoredTrack = LocalTrack & {
  /** Chiave anti-duplicato: nome + dimensione + data di modifica, o la fonte per i download. */
  sourceKey: string;
  fileName: string;
  artworkBytes: number;
  /**
   * Sempre valorizzata su disco; i record più vecchi, senza il campo, si leggono come 'local'.
   * Fa eccezione la copia di un brano in evidenza, riconosciuta anche dalla sola sourceKey (vedi
   * readStoredTrack).
   */
  source: LocalTrackSource;
  attribution: LocalTrackAttribution | null;
};

const TRACK_SOURCES: readonly LocalTrackSource[] = [
  'local',
  'audius-download',
  'podcast-download',
  'featured-download',
];

function isTrackSource(value: unknown): value is LocalTrackSource {
  return typeof value === 'string' && (TRACK_SOURCES as readonly string[]).includes(value);
}

/** Legge l'attribuzione da un record (dati di versioni future o rovinati → null). */
export function readAttribution(value: unknown): LocalTrackAttribution | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const field = (key: string): string | null => {
    const raw = r[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };
  const attribution: LocalTrackAttribution = {
    sourceName: field('sourceName'),
    sourceUrl: field('sourceUrl'),
    licenseName: field('licenseName'),
    licenseUrl: field('licenseUrl'),
    creditLine: field('creditLine'),
  };
  // Un'attribuzione tutta vuota non vale la pena di esistere.
  return Object.values(attribution).some((entry) => entry !== null) ? attribution : null;
}

/**
 * La fonte di un record. Una sourceKey che è ESATTAMENTE la chiave della copia di un brano in
 * evidenza (['download', 'featured-download', 'featured:<shareId>']) vale 'featured-download'
 * qualunque cosa dica il campo `source`: ripara IN LETTURA i record che una versione precedente ha
 * riscritto come 'local' (non conosceva la fonte, e setTrackDuration salvava ciò che aveva letto).
 * Sul disco quei record restano 'local' finché non li riscrive repairFeaturedCopySources
 * (store.ts): il player non salva di nuovo la durata di un brano che ne ha già una, quindi da soli
 * non si correggono mai. Un file dell'ascoltatore non può avere quella chiave, nemmeno con un nome
 * che comincia allo stesso modo (download-key.ts). Per tutto il resto: il campo, o 'local' se
 * manca o non si riconosce (i record salvati prima di "Scarica il permesso" sono file locali; il
 * download di una fonte sconosciuta non arriva fin qui: readStoredTrack lo scarta).
 */
function readSource(source: unknown, sourceKey: string): LocalTrackSource {
  if (isFeaturedCopySourceKey(sourceKey)) return 'featured-download';
  return isTrackSource(source) ? source : 'local';
}

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

/**
 * Record letto da IndexedDB, controllato (dati di versioni future o rovinati vengono scartati). Fra
 * gli scartati c'è il download di una fonte che questa versione non conosce (download-key.ts): per
 * questa versione quel brano non esiste, quindi non lo elenca, non lo suona, non ne legge il testo
 * e soprattutto non lo riscrive. Resta sul disco com'è, per la versione che lo sa leggere.
 */
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
  if (isUnknownDownloadSourceKey(r.sourceKey)) return null;
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
    source: readSource(r.source, r.sourceKey),
    attribution: readAttribution(r.attribution),
  };
}

export function toPublic(record: StoredTrack): LocalTrack {
  const track: LocalTrack = {
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
  // I file locali restano con la stessa forma di sempre: fonte, attribuzione e chiave del download
  // compaiono solo sui brani scaricati, così chi li legge può distinguerli e mostrarne i crediti.
  if (record.source !== 'local') {
    track.source = record.source;
    track.attribution = record.attribution;
    // La chiave si espone solo se è quella di un download di QUESTA fonte: un record con una
    // chiave che non torna resta senza (per una copia di un brano in evidenza vuol dire «non
    // verificabile», vedi featured-offline-sync).
    const download = readDownloadSourceKey(record.sourceKey);
    if (download && download.source === record.source) track.downloadKey = download.downloadKey;
  }
  return track;
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
        // Si riscrive il record COM'È sul disco, cambiando solo la durata e la fonte (quella
        // riletta: una copia di un brano in evidenza salvata come 'local' torna a dirlo da sé).
        // Riscrivere il record ripulito farebbe perdere i campi che questa versione non conosce.
        return {
          ...(current as Record<string, unknown>),
          source: record.source,
          durationSeconds: duration,
        };
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

/**
 * True se la libreria contiene almeno un brano scaricato da questa fonte (solo i metadati, nessun
 * Blob). Leggero: lo usa il mount globale della verifica delle copie dei brani in evidenza per
 * sapere se c'è qualcosa da verificare anche quando il registro in localStorage è vuoto o perso,
 * senza caricare store.ts e i lettori di tag. Se il database della libreria non esiste ancora (chi
 * non ha mai aperto «La tua musica») risponde false senza crearlo, dove il browser lo sa dire.
 * Lancia se la libreria non si riesce a leggere: chi chiama riprova più tardi.
 */
export async function hasDownloadedTrack(
  source: DownloadedTrackSource,
  db?: LocalMusicDb,
): Promise<boolean> {
  if (!db && (await localMusicDbExists()) === false) return false;
  const rows = await (db ?? defaultLocalMusicDb()).getAll('tracks');
  return rows.some((row) => readStoredTrack(row)?.source === source);
}
