// @polsia:user-owned — libreria musicale sul dispositivo: i file audio dell'ascoltatore.
//
// Design legale: i file NON lasciano mai il dispositivo (nessun upload, nessuna copia sul
// server). Solco è solo un lettore locale: metadati, file e copertine vivono in IndexedDB nel
// browser dell'ascoltatore, e i brani locali non contano mai per gli ascolti del piano Free.

/**
 * Da dove viene un brano della libreria:
 *  - 'local': file scelto dall'ascoltatore (comportamento storico, nessuna attribuzione);
 *  - 'audius-download': brano Audius scaricato con "Scarica il permesso" (licenza aperta);
 *  - 'podcast-download': episodio podcast scaricato dalla sua enclosure RSS.
 * I file scaricati stanno negli stessi store di IndexedDB dei file locali e si riproducono allo
 * stesso modo (object URL, Media Session), senza contare per gli ascolti Free.
 */
export type LocalTrackSource = 'local' | 'audius-download' | 'podcast-download';

/** Le sole fonti che producono un download (non un file già locale). */
export const DOWNLOADED_TRACK_SOURCES = ['audius-download', 'podcast-download'] as const;
export type DownloadedTrackSource = (typeof DOWNLOADED_TRACK_SOURCES)[number];

/**
 * Attribuzione di un brano scaricato, mostrata nella Libreria e dal player. Per i file locali è
 * assente (null): un file dell'ascoltatore non porta crediti.
 */
export type LocalTrackAttribution = {
  /** Fonte leggibile, es. "Audius" o il nome dello show podcast. */
  sourceName: string | null;
  /** Pagina ufficiale della fonte (brano Audius, episodio). */
  sourceUrl: string | null;
  /** Nome della licenza, es. "Audius Open Music License". */
  licenseName: string | null;
  /** URL della licenza. */
  licenseUrl: string | null;
  /** Nota di copyright o credito aggiuntivo. */
  creditLine: string | null;
};

/** Un brano aggiunto dall'ascoltatore e salvato solo sul suo dispositivo. */
export type LocalTrack = {
  /** Identificativo casuale (UUID), mai derivato dal file. */
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSeconds: number | null;
  /** Tipo audio che il browser sa riprodurre (vedi SUPPORTED_AUDIO_TYPES). */
  mimeType: string;
  /** Dimensione del file audio in byte. */
  size: number;
  /** Momento dell'aggiunta (epoch ms). */
  addedAt: number;
  hasArtwork: boolean;
  /**
   * Fonte del brano. Assente sui file locali (e sui record salvati prima di questa funzione):
   * usa localTrackSource() per leggerla sempre con un valore sicuro.
   */
  source?: LocalTrackSource;
  /** Attribuzione dei brani scaricati; assente/null per i file locali. */
  attribution?: LocalTrackAttribution | null;
};

/** Fonte di un brano, con 'local' come valore sicuro quando il campo è assente. */
export function localTrackSource(track: Pick<LocalTrack, 'source'>): LocalTrackSource {
  return track.source ?? 'local';
}

/** Attribuzione di un brano, o null quando assente (ogni file locale). */
export function localTrackAttribution(
  track: Pick<LocalTrack, 'attribution'>,
): LocalTrackAttribution | null {
  return track.attribution ?? null;
}

/** Tipi audio accettati, se il browser li sa riprodurre (canPlayType). */
export const SUPPORTED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/ogg',
] as const;

export type SupportedAudioType = (typeof SUPPORTED_AUDIO_TYPES)[number];

/** Dimensione massima di un singolo file audio: 200 MiB. */
export const MAX_LOCAL_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Perché un file non è stato aggiunto. 'error' copre i guasti imprevisti del database (non lo
 * spazio esaurito, che è 'quota'): il file è saltato e il resto del lotto prosegue.
 */
export type LocalSkipReason = 'unsupported' | 'too_large' | 'duplicate' | 'quota' | 'error';

export type LocalSkippedFile = { name: string; reason: LocalSkipReason };

export type AddFilesResult = { added: LocalTrack[]; skipped: LocalSkippedFile[] };

export type AddFilesProgress = {
  /** File elaborati finora (aggiunti o saltati). */
  processed: number;
  total: number;
  /** Nome (ripulito) dell'ultimo file elaborato. */
  fileName: string;
};

export type AddFilesOptions = { onProgress?: (progress: AddFilesProgress) => void };

export type LocalMusicUsage = {
  tracks: number;
  /** Byte occupati dai brani della libreria (audio + copertine). */
  bytes: number;
  /** Quota stimata dal browser per il sito (navigator.storage.estimate), null se ignota. */
  quota: number | null;
  /** Spazio ancora libero stimato (quota - uso del sito), null se ignoto. */
  available: number | null;
};

export type PersistenceResult = 'granted' | 'denied' | 'unsupported';

export type ArtworkImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export type ArtworkImage = { mimeType: ArtworkImageType; bytes: Uint8Array };

/** Tag letti dal file: tutto facoltativo, mai fidato (vedi tag-utils.ts). */
export type AudioTags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: ArtworkImage | null;
  /** Durata dichiarata dal contenitore (mvhd degli MP4), null se assente. */
  durationSeconds: number | null;
};

export function emptyTags(): AudioTags {
  return { title: null, artist: null, album: null, artwork: null, durationSeconds: null };
}
