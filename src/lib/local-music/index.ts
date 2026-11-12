// @polsia:user-owned — punto d'ingresso della libreria musicale sul dispositivo.
//
// I file dell'ascoltatore restano solo sul suo dispositivo (IndexedDB): nessun upload, nessuna
// copia sul server, e i brani locali non contano per gli ascolti del piano Free. Moduli solo per
// il browser: da usare in componenti 'use client' (l'import è comunque sicuro lato server, le API
// del browser si toccano solo alla prima chiamata). Il player importa '@/lib/local-music/playback'
// (solo lettura), non questo indice: l'aggiunta con i lettori di tag resta fuori dal suo bundle.

export { LocalMusicUnavailableError } from '@/lib/local-music/idb';
export {
  createObjectUrlForArtwork,
  createObjectUrlForTrack,
  type ObjectUrlHandle,
} from '@/lib/local-music/playback';
export {
  getArtworkBlob,
  getTrack,
  getTrackBlob,
  setTrackDuration,
} from '@/lib/local-music/reader';
export {
  type AddDownloadedResult,
  addDownloadedTrack,
  addFiles,
  clearAll,
  type DownloadedTrackInput,
  isLocalMusicSupported,
  listTracks,
  removeTrack,
  requestPersistence,
  usage,
} from '@/lib/local-music/store';
export {
  type AddFilesOptions,
  type AddFilesProgress,
  type AddFilesResult,
  DOWNLOADED_TRACK_SOURCES,
  type DownloadedTrackSource,
  type LocalMusicUsage,
  type LocalSkippedFile,
  type LocalSkipReason,
  type LocalTrack,
  type LocalTrackAttribution,
  type LocalTrackSource,
  localTrackAttribution,
  localTrackSource,
  MAX_LOCAL_FILE_BYTES,
  type PersistenceResult,
  SUPPORTED_AUDIO_TYPES,
} from '@/lib/local-music/types';
