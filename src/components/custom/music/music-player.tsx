// @polsia:user-owned — player unico condiviso tra le pagine: mini player + player a schermo intero.
'use client';

import {
  ChevronDown,
  ExternalLink,
  Gauge,
  Infinity as InfinityIcon,
  ListMusic,
  LoaderCircle,
  MicVocal,
  Music2,
  Pause,
  Play,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ShareMenu } from '@/components/custom/share-menu';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { FEATURED_FREE_MONTHLY_PLAYS, permitRecordsPlay } from '@/lib/business/play-quota';
import {
  audiusTrackIdFromQualifiedId,
  songShareImagePath,
  songShareText,
  songShareUrl,
} from '@/lib/business/social-share';
import { QUIZ_SHARE_TITLE, songQuizShare } from '@/lib/business/song-quiz';
import { HOME_TRACK_COVER_PREFIX } from '@/lib/contracts/home-tracks';
import {
  AudiusPlaybackCheckSchema,
  type AudiusTrackSearchResult,
  MusicTrendingResponseSchema,
} from '@/lib/contracts/music';
import {
  createObjectUrlForArtwork,
  createObjectUrlForTrack,
  getTrack,
  type ObjectUrlHandle,
  setTrackDuration,
} from '@/lib/local-music/playback';
import {
  AudioDecks,
  GAPLESS_DECKS_ENABLED,
  HAVE_METADATA,
  preloadDeck,
  releaseDeck,
  type SpareLoad,
  sameSpareLoad,
  spareReadyFor,
  wantsSparePreload,
} from '@/lib/music/audio-decks';
import {
  declarePlaybackSession,
  primeMediaElement,
  releasePlaybackSession,
} from '@/lib/music/audio-session';
import {
  audioComIdFromQualifiedId,
  currentAudioComQualifiedId,
  isAudioComStreamFresh,
} from '@/lib/music/audiocom-license';
import {
  AUTOPLAY_BATCH,
  selectAutoplayCandidates,
  setAutoplay,
  useAutoplay,
} from '@/lib/music/autoplay';
import { parseVideoTitle, videoTitleSong } from '@/lib/music/background-match';
import { setDataSaver, useDataSaver } from '@/lib/music/data-saver';
import { isFeaturedPlayId } from '@/lib/music/featured-track-id';
import {
  createListeningClock,
  observeListening,
  restartListeningSample,
  restoreListening,
} from '@/lib/music/listening-time';
import {
  type ActionPlan,
  applyPositionState,
  MEDIA_SESSION_ACTIONS,
  mediaArtwork,
  mediaPositionState,
  mediaSessionActionPlan,
  mediaSessionKind,
  type SessionAction,
  seekMediaElement,
  seekTargetSeconds,
} from '@/lib/music/media-session';
import {
  type AccessSnapshot,
  decideAdvance,
  isReplay,
  needsRightsCheck,
  pickNextIndex,
  playsWhileHidden,
  predictPlayBlock,
  type RightsVerdict,
  rememberStart,
  rightsVerdictFromReason,
  shouldPrefetchNext,
} from '@/lib/music/playback-prefetch';
import {
  applyElementSpeed,
  nearestYouTubeRate,
  PLAYBACK_SPEEDS,
  setPlaybackSpeed,
  usePlaybackSpeed,
} from '@/lib/music/playback-speed';
import {
  AUDIOCOM_STREAM_EXPIRED_MESSAGE,
  failureLink,
  failureMessage,
  OFFLINE_RESUME_MESSAGE,
  PLAY_PERMIT_UNCONFIRMED_MESSAGE,
  showsFreePlayCounter,
  UNAVAILABLE_SKIP_MESSAGE,
  YOUTUBE_QUEUE_UNPLAYABLE_MESSAGE,
} from '@/lib/music/player-messages';
import { PLAYER_STORAGE_KEY, STOP_PLAYER_EVENT } from '@/lib/music/player-session';
import { loadYouTubeIframeApi } from '@/lib/music/youtube-iframe-api';
import {
  continuesInRun,
  type PendingRunMove,
  playerListsRun,
  predatesMove,
  readPlayerReport,
  reportedRunPosition,
  runHoldsIndex,
  runMoveCommand,
  type YouTubeRun,
  youtubeRunAt,
} from '@/lib/music/youtube-runs';
import { BackgroundListenButton } from './background-listen-button';
import { BackgroundSwitchNotice, useReturnNotice } from './background-switch-notice';
import noticeStyles from './background-switch-notice.module.css';
import {
  isLocalTrack,
  LOCAL_MISSING_MESSAGE,
  LOCAL_UNAVAILABLE_MESSAGE,
  LOCAL_UNPLAYABLE_MESSAGE,
  localTrackId,
  persistedQueueItem,
  restoreLocalItems,
} from './local-tracks';
import { LyricsPanel } from './lyrics-panel';
import lyricsStyles from './lyrics-panel.module.css';
import { lyricsTargetFor } from './lyrics-target';
import styles from './music-player.module.css';
import { RemoveVideoButton } from './remove-video-button';
import { YouTubePremiumButton } from './youtube-premium-button';

export type MusicPlaybackMode =
  | 'audius'
  | 'solco'
  | 'radio'
  | 'podcast'
  | 'jamendo'
  | 'youtube'
  // Imported song (artist + title): found on YouTube when its turn comes, then played there.
  | 'song'
  // The listener's own file ("La tua musica", qualifiedId local:<id>): played from IndexedDB on
  // this device; nothing about it reaches the server (see local-tracks.ts).
  | 'local'
  // A song uploaded to the public library (qualifiedId upload:<id>): a PUBLIC file on Vercel Blob,
  // streamed directly from its CDN URL (track.streamUrl). See public-uploads.server.ts.
  // Anche i brani in evidenza della Home (qualifiedId upload:<pathname dello store>, vedi
  // featured-track-id.ts): stream dal proxy /api/music/home-tracks/stream, che richiede l'account e
  // conta gli avvii nel limite Free dei brani in evidenza (30 al mese); il player chiede prima il
  // permesso di /api/music/plays (solo verifica), come per Audius.
  // Anche i brani di audio.com (qualifiedId audiocom:<id>, solo licenze CC ammesse, mai cover):
  // stesso stream https diretto, ma con il permesso di /api/music/plays prima dell'audio (accesso
  // obbligatorio, conteggio nel limite Free: vedi permitRecordsPlay e audiocom-tracks.ts).
  | 'upload';

export type MusicPlayerTrack = {
  qualifiedId: string;
  title: string;
  artistName: string;
  /** Album name for the lock screen (local files: from their tags). */
  album?: string | null;
  artistUrl?: string | null;
  artworkUrl?: string | null;
  sourceLabel: string;
  sourceUrl: string | null;
  sourceUrlLabel?: string;
  durationSeconds?: number | null;
  albumId?: string | null;
  /** For a YouTube video found from an imported song: the song's qualifiedId (song:…). */
  importedFrom?: string | null;
  /** Direct public stream URL (playbackMode 'upload': the Vercel Blob CDN URL, or audio.com's). */
  streamUrl?: string | null;
  playbackMode?: MusicPlaybackMode;
  credits?: string[];
};

export type RepeatMode = 'off' | 'all' | 'one';

type ActiveTrack = MusicPlayerTrack & { streamPath: string };
type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/** Copertine servite da Solco già provate in questa pagina: true = c'è, false = non c'è. */
const coverChecks = new Map<string, boolean | 'pending'>();

/**
 * Una copertina dei brani in evidenza (proxy di Solco) può non esistere: un URL che risponde 404
 * lascerebbe la schermata di blocco senza immagine. Restituisce l'URL solo se già confermato;
 * altrimenti null (icona di Solco) e, se nuovo, lo prova e chiama `onReady` quando è confermato.
 */
function verifiedCover(url: string | null | undefined, onReady: () => void): string | null {
  if (!url) return null;
  if (!url.startsWith(`${HOME_TRACK_COVER_PREFIX}?`)) return url;
  const state = coverChecks.get(url);
  if (state === true) return url;
  if (state === undefined && typeof window !== 'undefined' && typeof window.Image === 'function') {
    coverChecks.set(url, 'pending');
    const probe = new window.Image();
    probe.onload = () => {
      coverChecks.set(url, true);
      onReady();
    };
    probe.onerror = () => coverChecks.set(url, false);
    probe.src = url;
  }
  return null;
}

/**
 * Tempo trascorso del brano in un piccolo store esterno (letto con useSyncExternalStore): cambia
 * ~4 volte al secondo mentre l'audio suona, quindi non sta nello stato del provider né nel contesto
 * principale. Così ogni avanzamento ridisegna solo barra, tempo e cursore, non il provider, la coda
 * del player a schermo intero e i componenti che leggono useMusicPlayer() (vedi useMusicPlayerElapsed).
 */
type ElapsedStore = {
  get: () => number;
  set: (seconds: number) => void;
  subscribe: (listener: () => void) => () => void;
};

function createElapsedStore(): ElapsedStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (seconds) => {
      if (Object.is(seconds, value)) return;
      value = seconds;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const MusicPlayerElapsedContext = createContext<ElapsedStore | null>(null);
const noElapsed = () => 0;
const noElapsedSubscription = () => () => undefined;

/** Secondi trascorsi del brano corrente (0 fuori dal player): solo chi lo legge si ridisegna. */
export function useMusicPlayerElapsed() {
  const store = useContext(MusicPlayerElapsedContext);
  return useSyncExternalStore(
    store?.subscribe ?? noElapsedSubscription,
    store?.get ?? noElapsed,
    noElapsed,
  );
}

type MusicPlayerValue = {
  currentTrack: ActiveTrack | null;
  status: PlaybackStatus;
  durationSeconds: number;
  queue: ActiveTrack[];
  queueIndex: number;
  errorMessage: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Autoplay continuo: a coda finita prosegue da solo con brani consigliati (fonte lecita Audius). */
  autoplay: boolean;
  /** Velocità "slowed / sped up" (0.5–2×); 1 = normale. Cambia tono sugli stream HTML5. */
  playbackSpeed: number;
  expanded: boolean;
  /** true: Premium, ascolti illimitati; false: Free, 40 ascolti completi al mese; null: verifica in corso. */
  premium: boolean | null;
  previewEnded: boolean;
  /** Motivo del blocco dell'ultimo avvio (account free / ospite), null se nessuno. */
  playBlock: PlayBlock | null;
  /** Ascolti usati questo mese e limite (null = illimitati): Audius, podcast e audio.com. */
  playsUsed: number | null;
  playsLimit: number | null;
  /** Avvii dei brani in evidenza della Home usati questo mese e il loro limite (null = illimitati). */
  featuredPlaysUsed: number | null;
  featuredPlaysLimit: number | null;
  /** Risolve true se il brano è partito davvero (false: bloccato, rifiutato, non riproducibile). */
  playTrack: (
    track: MusicPlayerTrack,
    streamPath: string,
    queue?: MusicPlayerTrack[],
  ) => Promise<boolean>;
  togglePlayback: () => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack: () => Promise<void>;
  seekTo: (seconds: number) => void;
  stopPlayback: () => void;
  /**
   * Files removed from this device ("La tua musica"): out of the queue and out of memory (object
   * URLs revoked, spare deck released), so they never play again; if the current item is one of
   * them the player stops. Library ids, or 'all' for every local file.
   */
  forgetLocalTracks: (ids: readonly string[] | 'all') => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  /** Accende/spegne l'autoplay continuo (per dispositivo). */
  toggleAutoplay: () => void;
  /** Imposta la velocità di riproduzione (ritagliata a 0.5–2×). */
  setSpeed: (speed: number) => void;
  setExpanded: (expanded: boolean) => void;
  /**
   * Da chiamare come prima istruzione di un tocco che avvierà l'audio dopo un'attesa di rete
   * (es. "Ascolta in background"): sblocca l'elemento <audio> dentro il gesto (iOS). La sessione
   * audio 'playback' viene dichiarata solo subito prima di play(), mai mentre suona un video YouTube.
   */
  primeAudio: () => void;
  /**
   * true se `qualifiedId` è ancora il brano corrente, letto al momento (non dall'ultimo render):
   * chi aspetta la rete (es. "Rimuovi video") non agisce su un brano cambiato nel frattempo.
   */
  isCurrentTrack: (qualifiedId: string) => boolean;
  /**
   * Sostituisce il brano corrente con `track` nello stesso punto della coda e lo avvia: il resto
   * della coda resta (es. la versione solo audio al posto di un video YouTube). Risolve true se è
   * partito davvero.
   */
  replaceCurrentTrack: (track: MusicPlayerTrack, streamPath: string) => Promise<boolean>;
};

const MusicPlayerContext = createContext<MusicPlayerValue | null>(null);

const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const HISTORY_THRESHOLD_SECONDS = 30;

/** Le radio e i podcast non passano dalla verifica dei diritti Audius: sono stream pubblici. */
export function isOpenStream(track: Pick<MusicPlayerTrack, 'playbackMode'>) {
  return (
    track.playbackMode === 'radio' ||
    track.playbackMode === 'podcast' ||
    track.playbackMode === 'jamendo' ||
    track.playbackMode === 'youtube' ||
    // Brano pubblico caricato dagli utenti: file pubblico su Blob, stream diretto, niente diritti.
    // Anche audio.com (licenza già filtrata dal server): niente /playback, ma il suo audio parte
    // solo dopo il permesso, che è l'unico controllo (vedi permitRecordsPlay in playCurrentTrack).
    track.playbackMode === 'upload'
  );
}

/**
 * Un brano di audio.com con l'id storico `upload:audiocom~<id>` (coda salvata nel browser prima che
 * audio.com contasse nel limite Free) prende l'id di oggi, `audiocom:<id>`: continua a suonare dallo
 * stesso stream, ma con accesso obbligatorio e conteggio come ogni brano di audio.com. Ogni altro
 * elemento resta identico (vedi currentAudioComQualifiedId).
 */
function withCurrentPlayId<T extends MusicPlayerTrack>(track: T): T {
  // Coda letta dal browser: un elemento rovinato (id non testuale) resta com'è, senza eccezioni.
  if (typeof track.qualifiedId !== 'string') return track;
  const qualifiedId = currentAudioComQualifiedId(track.qualifiedId);
  return qualifiedId === track.qualifiedId ? track : { ...track, qualifiedId };
}

const STORAGE_KEY = PLAYER_STORAGE_KEY;
/**
 * Menu aperti dal player a schermo intero: sopra il player (.full ha z-index 60, il video
 * espanso 61). Con lo z-index standard (50) restavano disegnati sotto, invisibili.
 */
const FULL_PLAYER_MENU = 'z-[70]';
const MAX_RECONNECTS = 3;
/** On-demand streams (Audius, Jamendo, podcast): one immediate retry after a network drop. */
const MAX_MEDIA_RETRIES = 1;
/**
 * Brani di fila che non partono affatto, saltati da soli: oltre, il problema non è del brano (limite
 * di richieste, servizio giù) e saltare tutta la coda moltiplicherebbe solo le richieste.
 */
const MAX_START_FAILURE_SKIPS = 3;
/**
 * Diretta radio ferma in attesa di dati ('waiting'/'stalled') da così tanto senza avanzare: la
 * connessione è appesa senza un 'error' (encoder bloccato, cambio di rete), si riconnette.
 */
const LIVE_STALL_MS = 12_000;
/** Lotto dell'autoplay continuo: una richiesta appesa non lascia il player in 'loading' per sempre. */
const AUTOPLAY_FETCH_TIMEOUT_MS = 15_000;
const YOUTUBE_HIDDEN_NOTICE =
  'Il prossimo è un video YouTube: riprende quando torni su Solco. I video non suonano in background.';

/** Solco is not on screen (locked phone, other app or tab): YouTube must never play then. */
function isPageHidden() {
  return typeof document !== 'undefined' && document.visibilityState !== 'visible';
}

function mediaSessionOrNull(): MediaSession | null {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
    ? navigator.mediaSession
    : null;
}

function setSessionPlaybackState(state: MediaSessionPlaybackState) {
  const session = mediaSessionOrNull();
  if (!session) return;
  try {
    session.playbackState = state;
  } catch {
    // Read-only in some engines: the browser then infers it from the media element.
  }
}

function isDomError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;
}

/**
 * Un avvio trattenuto, non fallito: iOS rifiuta play() senza un tocco in una pagina sospesa
 * (NotAllowedError), oppure il sistema ha messo in pausa l'elemento mentre partiva (chiamata, Siri,
 * cuffie scollegate: AbortError). L'elemento tiene la sorgente e il player va in pausa: il prossimo
 * Play (anche dalla schermata di blocco) riparte da lì. Un AbortError su un elemento già svuotato
 * (lo ha liberato handleError o un altro avvio) non conta: se ne occupa chi l'ha svuotato.
 */
function startHeldBack(error: unknown, audio: Pick<HTMLMediaElement, 'getAttribute'>) {
  if (isDomError(error, 'NotAllowedError')) return true;
  return isDomError(error, 'AbortError') && Boolean(audio.getAttribute('src'));
}

/** Il dispositivo dice di essere senza rete (un ritentativo adesso fallirebbe subito). */
function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** The server's denial reason carried by a failed check (apiFetch puts the JSON body in `cause`). */
function denialReason(error: unknown): unknown {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null
    ? (error.cause as { reason?: unknown }).reason
    : undefined;
}

function clearTimer(timer: { current: number | null }) {
  if (timer.current !== null) window.clearTimeout(timer.current);
  timer.current = null;
}

type AccessBody = {
  premium?: unknown;
  signedIn?: unknown;
  playsUsed?: unknown;
  playsLimit?: unknown;
  featuredPlaysUsed?: unknown;
  featuredPlaysLimit?: unknown;
};

const numberOrNull = (value: unknown) => (typeof value === 'number' ? value : null);

function accessSnapshot(body: AccessBody): AccessSnapshot {
  return {
    premium: body.premium === true,
    signedIn: body.signedIn === true,
    playsUsed: numberOrNull(body.playsUsed),
    playsLimit: numberOrNull(body.playsLimit),
    featuredPlaysUsed: numberOrNull(body.featuredPlaysUsed),
    featuredPlaysLimit: numberOrNull(body.featuredPlaysLimit),
  };
}

/** Rights + quota checks prepared ~20 s before the end of the current item (see playback-prefetch). */
type PreparedNext = {
  from: string;
  index: number;
  qualifiedId: string;
  rights: RightsVerdict;
};

export function isYouTubeTrack(track: Pick<MusicPlayerTrack, 'playbackMode'> | null | undefined) {
  return track?.playbackMode === 'youtube';
}

function youtubeVideoId(track: Pick<MusicPlayerTrack, 'qualifiedId'>) {
  return /^youtube:([A-Za-z0-9_-]{11})$/.exec(track.qualifiedId)?.[1] ?? null;
}

/** Minimal surface of the official YouTube IFrame Player used by the Solco player. */
type YouTubeEngine = {
  loadVideoById: (videoId: string) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
  // Playlist API of the official player (YouTube prepares and starts the next video itself). The
  // real player exposes it once ready; without it every item is loaded with loadVideoById.
  loadPlaylist?: (playlist: string[], index?: number, startSeconds?: number) => void;
  nextVideo?: () => void;
  previousVideo?: () => void;
  playVideoAt?: (index: number) => void;
  getPlaylistIndex?: () => number;
  getPlaylist?: () => string[] | null | undefined;
  getVideoData?: () => { video_id?: string } | null | undefined;
  // Velocità "slowed/sped up": YouTube accetta solo i valori di getAvailablePlaybackRates e tiene
  // il tono, quindi lì l'effetto è solo di tempo (vedi nearestYouTubeRate).
  setPlaybackRate?: (rate: number) => void;
  getAvailablePlaybackRates?: () => number[];
};

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
const YT_CUED = 5;

export function isLiveTrack(track: Pick<MusicPlayerTrack, 'playbackMode'> | null | undefined) {
  return track?.playbackMode === 'radio';
}

function safeStreamPath(path: string, track: MusicPlayerTrack) {
  if (typeof window === 'undefined') return null;
  const expected = trackStreamPath(track);
  if (!expected) return null;
  // Un brano della libreria pubblica suona da un URL pubblico su Vercel Blob (cross-origin, https,
  // *.blob.vercel-storage.com), ricavato dal suo streamUrl già validato dal contratto API; un brano
  // di audio.com dal suo stream https su audio.com (contratto AudioComTrackSchema). Il valore
  // autorevole è `expected` stesso: lo si accetta direttamente invece di pretendere un percorso
  // same-origin.
  if (track.playbackMode === 'upload') return expected;
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== expected) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

/** Percorso same-origin dello stream di un elemento riproducibile, oppure null. */
export function trackStreamPath(track: MusicPlayerTrack) {
  if (track.playbackMode === 'radio') {
    const station = /^radio:([A-Za-z0-9_-]{1,128})$/.exec(track.qualifiedId)?.[1];
    return station ? `/api/music/radio/${encodeURIComponent(station)}/stream` : null;
  }
  if (track.playbackMode === 'podcast') {
    const match = /^podcast:([0-9]{1,20})~([A-Za-z0-9_-]{1,64})$/.exec(track.qualifiedId);
    if (!match?.[1] || !match[2]) return null;
    return `/api/music/podcasts/${match[1]}/episodes/${match[2]}/stream`;
  }
  if (track.playbackMode === 'jamendo') {
    const id = /^jamendo:([0-9]{1,20})$/.exec(track.qualifiedId)?.[1];
    return id ? `/api/music/jamendo/${id}/stream` : null;
  }
  if (track.playbackMode === 'youtube') {
    // Never fetched: YouTube plays only inside the official, visible IFrame player.
    const id = youtubeVideoId(track);
    return id ? `/youtube/${id}` : null;
  }
  if (track.playbackMode === 'song') {
    // Never fetched: resolved to a YouTube video just before playing.
    const id = /^song:([a-f0-9]{32})$/.exec(track.qualifiedId)?.[1];
    return id ? `/song/${id}` : null;
  }
  if (track.playbackMode === 'local') {
    // Never fetched: played from an object URL of the file stored on this device.
    const id = localTrackId(track.qualifiedId);
    return id ? `/local/${id}` : null;
  }
  if (track.playbackMode === 'upload') {
    const stream = track.streamUrl ?? '';
    // audio.com: lo stream è un link firmato del CDN che scade (X-Amz-Expires). Scaduto o quasi →
    // nessun percorso, così una coda salvata o una pagina rimasta aperta non prova un link morto.
    if (isAudioComTrack(track) && !isAudioComStreamFresh(stream)) return null;
    // Due casi: brano pubblico (upload utente o file in evidenza reso pubblico) → URL CDN https
    // diretto; brano in evidenza PRIVATO → percorso same-origin del proxy che lo serve dal server.
    if (/^https:\/\//.test(stream)) return stream;
    if (stream.startsWith('/api/music/home-tracks/stream?p=')) return stream;
    return null;
  }
  const match = /^audius:([A-Za-z0-9_-]{1,128})$/.exec(track.qualifiedId);
  if (!match?.[1]) return null;
  if (track.playbackMode === 'audius') {
    return `/api/music/audius/tracks/${encodeURIComponent(match[1])}/stream`;
  }
  if (track.playbackMode !== 'solco' || !track.albumId || !safeId.test(track.albumId)) return null;
  return `/api/music/albums/${encodeURIComponent(track.albumId)}/tracks/${encodeURIComponent(match[1])}/stream`;
}

/** Brano di audio.com (id `audiocom:<id>` o quello storico `upload:audiocom~<id>`). */
function isAudioComTrack(track: Pick<MusicPlayerTrack, 'qualifiedId'>) {
  return (
    typeof track.qualifiedId === 'string' &&
    audioComIdFromQualifiedId(currentAudioComQualifiedId(track.qualifiedId)) !== null
  );
}

/** Brano Audius (dal trending) → traccia del player, per l'autoplay continuo. */
function audiusResultToTrack(track: AudiusTrackSearchResult): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Solco · Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
    playbackMode: 'audius',
  };
}

function playbackPath(track: MusicPlayerTrack) {
  if (isOpenStream(track)) return null;
  if (track.playbackMode === 'jamendo') {
    const id = /^jamendo:([0-9]{1,20})$/.exec(track.qualifiedId)?.[1];
    return id ? `/api/music/jamendo/${id}/playback` : null;
  }
  const match = /^audius:([A-Za-z0-9_-]{1,128})$/.exec(track.qualifiedId);
  if (!match?.[1]) return null;
  if (track.playbackMode === 'audius') {
    return `/api/music/audius/tracks/${encodeURIComponent(match[1])}/playback`;
  }
  if (track.playbackMode !== 'solco' || !track.albumId || !safeId.test(track.albumId)) return null;
  return `/api/music/albums/${encodeURIComponent(track.albumId)}/tracks/${encodeURIComponent(match[1])}/playback`;
}

/** Permesso e verifica dei diritti: su una rete bloccata il player non resta in «caricamento». */
const PLAYBACK_CHECK_TIMEOUT_MS = 8_000;

async function verifyPlayback(track: MusicPlayerTrack) {
  // Open streams need no check; the listener's own files are never shown to the server.
  if (isOpenStream(track) || isLocalTrack(track)) return;
  const path = playbackPath(track);
  if (!path) throw new Error('Track is not an authorized album item');
  const verdict = await apiFetch(path, {
    schema: AudiusPlaybackCheckSchema,
    signal: AbortSignal.timeout(PLAYBACK_CHECK_TIMEOUT_MS),
  });
  if (!verdict.allowed) throw new Error(verdict.reason, { cause: verdict });
}

/** Rights check prepared before the end of the previous item: GET …/playback never consumes a play. */
async function prefetchRights(track: MusicPlayerTrack): Promise<RightsVerdict> {
  const path = playbackPath(track);
  if (!path) return 'denied';
  try {
    const verdict = await apiFetch(path, {
      schema: AudiusPlaybackCheckSchema,
      signal: AbortSignal.timeout(PLAYBACK_CHECK_TIMEOUT_MS),
    });
    return verdict.allowed ? 'allowed' : rightsVerdictFromReason(verdict.reason);
  } catch (error) {
    return rightsVerdictFromReason(denialReason(error));
  }
}

/** Why an item did not start: a local file has no server reason, only "not playable here". */
function playbackFailure(error: unknown, track: MusicPlayerTrack) {
  return isLocalTrack(track) ? LOCAL_UNPLAYABLE_MESSAGE : failureMessage(error, track);
}

/** Where the local object URLs come from: present, or why not (see loadLocalSource). */
type LocalSource = { ok: true; url: string } | { ok: false; reason: 'missing' | 'unavailable' };

/**
 * What a deck plays for an item: its same-origin stream path, or for a local file its object URL
 * (null until made). A local item's streamPath is a placeholder that is never fetched.
 */
function deckSource(
  track: Pick<ActiveTrack, 'qualifiedId' | 'playbackMode' | 'streamPath'>,
  localAudio: ReadonlyMap<string, ObjectUrlHandle>,
) {
  return isLocalTrack(track) ? (localAudio.get(track.qualifiedId)?.url ?? null) : track.streamPath;
}

function formattedTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export type PlayBlock = 'login_required' | 'monthly_limit';

type PlayPermit = {
  allowed: boolean;
  reason?: PlayBlock;
  used?: number;
  limit?: number | null;
  /**
   * audio.com: il server non ha confermato il permesso (rete assente, errore, registro degli
   * ascolti non disponibile). Nessuna route di stream ricontrolla quell'audio, quindi non parte.
   */
  unconfirmed?: true;
};

/** Chiede al server il permesso di avviare un brano (limite di 40 ascolti al mese per i free). */
/** Finds the YouTube video of an imported song; a ready-to-play track or a message. */
async function resolveSongTrack(
  track: MusicPlayerTrack,
): Promise<{ ok: true; track: ActiveTrack } | { ok: false; message: string; notFound?: boolean }> {
  const params = new URLSearchParams({ title: track.title });
  if (track.artistName) params.set('artist', track.artistName);
  try {
    const response = await fetch(`/api/music/resolve-song?${params.toString()}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as {
      video?: {
        videoId?: unknown;
        title?: unknown;
        channelTitle?: unknown;
        thumbnailUrl?: unknown;
      } | null;
      message?: unknown;
    } | null;
    if (!response.ok) {
      return {
        ok: false,
        message:
          typeof body?.message === 'string'
            ? body.message
            : 'Non è stato possibile cercare il brano. Riprova.',
      };
    }
    const video = body?.video;
    const videoId = typeof video?.videoId === 'string' ? video.videoId : '';
    if (!video || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return { ok: false, notFound: true, message: `Non ho trovato “${track.title}” su YouTube.` };
    }
    return {
      ok: true,
      track: {
        qualifiedId: `youtube:${videoId}`,
        // Keep the imported title and artist: they are what the listener chose.
        title: track.title,
        artistName: track.artistName,
        artworkUrl: typeof video.thumbnailUrl === 'string' ? video.thumbnailUrl : null,
        sourceLabel: 'YouTube',
        sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        sourceUrlLabel: 'Guarda su YouTube',
        durationSeconds: track.durationSeconds ?? null,
        playbackMode: 'youtube',
        streamPath: `/youtube/${videoId}`,
        importedFrom: track.qualifiedId,
      },
    };
  } catch {
    return { ok: false, message: 'Connessione non riuscita. Riprova.' };
  }
}

/**
 * True for an item that must never reach a Solco API: the listener's own file. Checked by mode and
 * by id, so a malformed local item (invalid id) is held back too.
 */
function isDeviceOnly(track: Pick<MusicPlayerTrack, 'playbackMode' | 'qualifiedId'>) {
  return track.playbackMode === 'local' || track.qualifiedId.startsWith('local:');
}

export async function requestPlayPermit(requestedId: string): Promise<PlayPermit> {
  // Un id storico di audio.com (`upload:audiocom~<id>`) vale come `audiocom:<id>`: chiede il
  // permesso come oggi, non passa per la via dei file pubblici (vedi withCurrentPlayId).
  const qualifiedId = currentAudioComQualifiedId(requestedId);
  // A local file needs no permit and counts for nothing (its id never leaves the device); same for
  // a public upload (`upload:<cuid>`). Un brano in evidenza (`upload:<pathname>`) invece chiede il
  // permesso come Audius: solo una verifica, l'ascolto lo registra la sua route di stream.
  if (qualifiedId.startsWith('local:')) return { allowed: true };
  if (qualifiedId.startsWith('upload:') && !isFeaturedPlayId(qualifiedId)) {
    return { allowed: true };
  }
  // audio.com: nessuna route di stream di Solco vedrà quell'audio, quindi questo permesso è l'unico
  // controllo (accesso e limite Free) e REGISTRA l'ascolto. Senza un sì esplicito: niente audio.
  const failClosed = permitRecordsPlay(qualifiedId);
  try {
    const response = await fetch('/api/music/plays', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qualifiedId }),
      signal: AbortSignal.timeout(PLAYBACK_CHECK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      allowed?: unknown;
      reason?: unknown;
      used?: unknown;
      limit?: unknown;
    };
    if (
      body.allowed === false &&
      (body.reason === 'login_required' || body.reason === 'monthly_limit')
    ) {
      return {
        allowed: false,
        reason: body.reason,
        used: typeof body.used === 'number' ? body.used : undefined,
        limit: typeof body.limit === 'number' ? body.limit : null,
      };
    }
    // audio.com: vale solo un 200 con allowed true (un 503 del registro degli ascolti, un errore o
    // una risposta strana non confermano nulla, e nessuna route di stream deciderà dopo).
    if (failClosed && (!response.ok || body.allowed !== true)) {
      return { allowed: false, unconfirmed: true };
    }
    return {
      allowed: true,
      used: typeof body.used === 'number' ? body.used : undefined,
      limit: typeof body.limit === 'number' ? body.limit : null,
    };
  } catch {
    // Network failure: let the server-side stream check decide (it enforces the same limit).
    // audio.com non ha quel controllo: senza rete verso Solco l'audio non parte.
    return failClosed ? { allowed: false, unconfirmed: true } : { allowed: true };
  }
}

/**
 * Registra un ascolto nella cronologia della Libreria (solo utenti autenticati; errori ignorati).
 * Mai per un file dell'ascoltatore: titolo e artista non lasciano il dispositivo.
 */
export function recordPlay(track: MusicPlayerTrack) {
  // I file locali e i brani della libreria pubblica non vanno nella cronologia: la cronologia non
  // porta lo streamUrl, quindi un upload ricostruito da lì non sarebbe riproducibile (voce morta).
  // Gli upload restano ascoltabili dalla pagina /pubblica (che ha lo streamUrl). Lo stesso per i
  // brani di audio.com (playbackMode 'upload', id audiocom:<id>): si ritrovano con la Cerca; il
  // conteggio del limite Free non dipende dalla cronologia (lo registra il permesso).
  if (isDeviceOnly(track) || track.playbackMode === 'upload') return;
  void apiFetch('/api/music/library', {
    method: 'POST',
    body: JSON.stringify({
      action: 'record_play',
      track: {
        qualifiedId: track.qualifiedId,
        title: track.title,
        artistName: track.artistName,
        artworkUrl: track.artworkUrl ?? null,
        sourceLabel: track.sourceLabel,
        sourceUrl: track.sourceUrl,
        albumId: track.albumId ?? null,
        durationSeconds: track.durationSeconds ?? null,
        playbackMode: track.playbackMode ?? 'audius',
      },
    }),
  }).catch(() => undefined);
}

export function useMusicPlayer() {
  const player = useContext(MusicPlayerContext);
  if (!player) throw new Error('useMusicPlayer deve essere usato dentro MusicPlayerProvider.');
  return player;
}

/** The shared player, or null outside MusicPlayerProvider (e.g. a component rendered alone). */
export function useOptionalMusicPlayer() {
  return useContext(MusicPlayerContext);
}

function Artwork({
  track,
  size,
  url = track.artworkUrl,
}: {
  track: MusicPlayerTrack;
  size: number;
  /** The cover to show (a local file's comes from the player's own object URL). */
  url?: string | null;
}) {
  // A cover that does not load (e.g. a featured file without embedded artwork) shows the icon.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (url && failedUrl !== url) {
    return (
      <Image
        src={url}
        alt=""
        width={size}
        height={size}
        unoptimized
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return track.playbackMode === 'radio' ? (
    <Radio aria-hidden="true" />
  ) : (
    <Music2 aria-hidden="true" />
  );
}

/** Barra sottile del mini player: si ridisegna da sola a ogni avanzamento (vedi ElapsedStore). */
function MiniProgress({
  store,
  duration,
  live,
}: {
  store: ElapsedStore;
  duration: number;
  live: boolean;
}) {
  const elapsed = useSyncExternalStore(store.subscribe, store.get, noElapsed);
  const progress = !live && duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
  return (
    <span className={styles.miniProgress} aria-hidden="true">
      <span style={{ width: `${progress}%` }} />
    </span>
  );
}

/** Cursore di avanzamento del player a schermo intero (solo lui segue il tempo). */
function SeekBar({
  store,
  duration,
  onSeek,
  disabled,
  label,
}: {
  store: ElapsedStore;
  duration: number;
  onSeek: (seconds: number) => void;
  disabled: boolean;
  label: string;
}) {
  // Risoluzione di 1 s (come step): niente render per i timeupdate dentro lo stesso secondo.
  const elapsed = useSyncExternalStore(store.subscribe, () => Math.floor(store.get()), noElapsed);
  return (
    <input
      className={styles.seek}
      type="range"
      min={0}
      max={duration || 0}
      step={1}
      value={Math.min(elapsed, duration || 0)}
      onChange={(event) => onSeek(Number(event.target.value))}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={`${formattedTime(elapsed)} di ${formattedTime(duration || 0)}`}
    />
  );
}

/** Tempo trascorso, accanto alla durata. */
function ElapsedTime({ store }: { store: ElapsedStore }) {
  const elapsed = useSyncExternalStore(store.subscribe, () => Math.floor(store.get()), noElapsed);
  return <span>{formattedTime(elapsed)}</span>;
}

/** Play/Pausa, o la rotella mentre carica o aspetta dati (prima era solo un'icona sbiadita). */
function PlayStateIcon({ status, buffering }: { status: string; buffering: boolean }) {
  if (status === 'loading' || (buffering && status === 'playing')) {
    return <LoaderCircle aria-hidden="true" className={styles.spin} />;
  }
  return status === 'playing' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />;
}

/** «Precedente»: sul primo elemento serve solo dopo 5 s (torna all'inizio), mai in diretta. */
function PreviousButton({
  store,
  firstItem,
  live,
  onPrevious,
}: {
  store: ElapsedStore;
  firstItem: boolean;
  live: boolean;
  onPrevious: () => void;
}) {
  const pastFiveSeconds = useSyncExternalStore(
    store.subscribe,
    () => store.get() > 5,
    () => false,
  );
  return (
    <button
      className={styles.skip}
      type="button"
      onClick={onPrevious}
      disabled={firstItem && (live || !pastFiveSeconds)}
      aria-label="Brano precedente"
    >
      <SkipBack aria-hidden="true" />
    </button>
  );
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Two <audio> decks (see audio-decks.ts). decks.current is the one playing: every
  // single-element path below uses it and follows the swaps; the spare only preloads the first
  // seconds of the next Audius/Solco track.
  const [decks] = useState(() => new AudioDecks());
  const recordedRef = useRef<string | null>(null);
  const [currentTrack, setCurrentTrack] = useState<ActiveTrack | null>(null);
  const [queue, setQueue] = useState<ActiveTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  // Tempo trascorso fuori dallo stato React (vedi ElapsedStore): ~4 aggiornamenti al secondo non
  // ridisegnano il provider.
  const [elapsedStore] = useState(createElapsedStore);
  const setElapsedSeconds = elapsedStore.set;
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  // Velocità "slowed / sped up": store per dispositivo (localStorage). Il ref serve ai gestori
  // imperativi (play, loadedmetadata), lo stato reattivo al render dei pulsanti.
  const playbackSpeed = usePlaybackSpeed();
  const playbackSpeedRef = useRef(playbackSpeed);
  playbackSpeedRef.current = playbackSpeed;
  const [expanded, setExpanded] = useState(false);
  // Pannello "Testo" del player a schermo intero (solo brani con i diritti sul testo, vedi
  // lyrics-target.ts). Resta aperto passando da un brano all'altro, come su Spotify.
  const [lyricsOpen, setLyricsOpen] = useState(false);
  // true solo fra il tocco su "Testo" (apertura) e il montaggio del pannello, che si porta in vista.
  const lyricsRevealRef = useRef(false);
  const consumeLyricsReveal = useCallback(() => {
    const reveal = lyricsRevealRef.current;
    lyricsRevealRef.current = false;
    return reveal;
  }, []);
  // Latest queue and index for the YouTube engine callbacks (set every render; an in-run move or a
  // followed YouTube advance updates the index at once, before the next render).
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const queueIndexRef = useRef(queueIndex);
  queueIndexRef.current = queueIndex;
  const ytHostRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<YouTubeEngine | null>(null);
  // Applica la velocità scelta al player YouTube (velocità discreta, tono invariato lì).
  const applyYouTubeRate = (player: YouTubeEngine | null) => {
    if (!player?.setPlaybackRate) return;
    try {
      player.setPlaybackRate(
        nearestYouTubeRate(playbackSpeedRef.current, player.getAvailablePlaybackRates?.()),
      );
    } catch {
      // Player non ancora pronto: lo riproveremo in onReady / onPlaying.
    }
  };
  // La velocità vive su uno store per dispositivo: applicala ai due deck e al player YouTube ogni
  // volta che cambia, anche mentre un brano suona (onRateChange aggiorna poi la Media Session).
  useEffect(() => {
    // La diretta radio ignora la velocità (il tono e la sincronia col live edge vanno preservati):
    // il deck attivo torna sempre a 1× se il brano corrente è live. La riserva precarica solo brani
    // on-demand (mai radio), quindi riceve la velocità reale.
    const liveNow = isLiveTrack(currentTrackRef.current);
    applyElementSpeed(decks.current, liveNow ? 1 : playbackSpeed);
    applyElementSpeed(decks.spareDeck, playbackSpeed);
    const player = ytPlayerRef.current;
    if (player?.setPlaybackRate) {
      try {
        player.setPlaybackRate(
          nearestYouTubeRate(playbackSpeed, player.getAvailablePlaybackRates?.()),
        );
      } catch {
        // Player non pronto.
      }
    }
  }, [playbackSpeed, decks]);
  // YouTube playlist runs (see youtube-runs.ts): the consecutive YouTube items loaded in the official
  // player as one playlist (null: it holds a single video), the queue item the player was sent to
  // (or followed to) and by which play request, and a move asked of it that YouTube has not
  // reported yet. Nothing is downloaded: YouTube prepares the next video inside its own player.
  const ytRunRef = useRef<YouTubeRun | null>(null);
  const ytAtRef = useRef<{ index: number; videoId: string; request: number } | null>(null);
  const ytPendingRef = useRef<PendingRunMove | null>(null);
  const ytRequestSeenRef = useRef(0);
  // The official player is playing, or re-buffering after it played. Set synchronously from its
  // state changes and from pausePlayback (the React status follows asynchronously): it decides
  // whether hiding Solco stopped a video that was playing ("video fermato" notice on return).
  const ytPlayingRef = useRef(false);
  // Stable controls that take the focus when the "video fermato" notice closes with it inside.
  const miniPlayRef = useRef<HTMLButtonElement>(null);
  const miniExpandRef = useRef<HTMLButtonElement>(null);
  const fullPlayRef = useRef<HTMLButtonElement>(null);
  const fullCollapseRef = useRef<HTMLButtonElement>(null);
  const [ytRequest, setYtRequest] = useState(0);
  const [premium, setPremium] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [playBlock, setPlayBlock] = useState<PlayBlock | null>(null);
  const [playsUsed, setPlaysUsed] = useState<number | null>(null);
  const [playsLimit, setPlaysLimit] = useState<number | null>(null);
  // Conteggio a parte dei brani in evidenza della Home (30 avvii al mese con Free).
  const [featuredPlaysUsed, setFeaturedPlaysUsed] = useState<number | null>(null);
  const [featuredPlaysLimit, setFeaturedPlaysLimit] = useState<number | null>(null);
  const [previewEnded, setPreviewEnded] = useState(false);
  const reconnectsRef = useRef(0);
  // Pending delayed radio reconnect (2nd and 3rd attempt): cleared on close and pause.
  const reconnectTimerRef = useRef<number | null>(null);
  // Diretta ferma in attesa di dati: dopo LIVE_STALL_MS senza avanzare si riconnette.
  const stallTimerRef = useRef<number | null>(null);
  // Punto da cui riprendere un elemento (coda ripristinata, ripresa dopo un errore o senza rete):
  // vale solo per QUELL'elemento. Un altro brano che carica non lo eredita mai (partirebbe a metà,
  // o in fondo e quindi saltato).
  const pendingSeekRef = useRef<{ qualifiedId: string; seconds: number } | null>(null);
  // Elemento on-demand fermato perché il dispositivo era senza rete: riparte una volta su 'online'.
  const offlineResumeRef = useRef<string | null>(null);
  // Brano on-demand (brani in evidenza compresi) fermato da un calo di rete MENTRE suonava, dopo aver
  // esaurito il ritentativo in corso: riparte da solo dal punto salvato quando l'ascoltatore torna su
  // Solco (schermo riacceso / scheda visibile o a fuoco) o quando torna la rete. Null = niente da riprendere.
  const dropResumeRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  // Background playback (see src/lib/music/playback-prefetch.ts and media-session.ts).
  const accessRef = useRef<AccessSnapshot | null>(null);
  // `hidden`: scelto a pagina nascosta (i video YouTube saltati), da rifare quando torna visibile.
  const nextPlanRef = useRef<{ key: string; index: number | null; hidden: boolean } | null>(null);
  const preparedRef = useRef<PreparedNext | null>(null);
  const startedAtRef = useRef(new Map<string, number>());
  const refreshOnPlayingRef = useRef(false);
  const deferredVideoRef = useRef<string | null>(null);
  const mediaRetryRef = useRef(0);
  const retryPositionRef = useRef(0);
  // Ripresa chiesta dall'ascoltatore (Play, schermata di blocco) su un elemento in pausa: lo stato
  // resta 'paused' finché play() non parte, ma un errore in quell'attesa non è «in pausa» (vedi
  // handleError). Vale per la richiesta di avvio in cui è stata fatta; una pausa la annulla.
  const resumeRequestRef = useRef<number | null>(null);
  const listeningRef = useRef(createListeningClock());
  const nowPlayingRef = useRef<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  // The listener's own files ("La tua musica"): object URLs of the audio stored in IndexedDB, by
  // qualifiedId (the current item and the prepared next one), and the cover of the current item.
  // Revoked when the item changes, the player closes or unmounts, never right after play().
  const localAudioRef = useRef(new Map<string, ObjectUrlHandle>());
  const localLoadsRef = useRef(new Map<string, Promise<LocalSource>>());
  const localArtworkRef = useRef<{ qualifiedId: string; url: string } | null>(null);
  const [localArtwork, setLocalArtwork] = useState<{ qualifiedId: string; url: string } | null>(
    null,
  );
  const localDurationsRef = useRef(new Set<string>());
  const unmountedRef = useRef(false);
  // A local item whose file is gone (or unplayable): skipped once the render has the queue.
  const [localSkip, setLocalSkip] = useState<{
    qualifiedId: string;
    request: number;
    message: string;
  } | null>(null);
  const ytEvents = useRef({
    onReady: () => {},
    onPlaying: () => {},
    onPaused: () => {},
    onEnded: () => {},
    onBuffering: () => {},
    onCued: () => {},
    onError: (_code: number) => {},
    onProgress: (_elapsed: number, _duration: number) => {},
  });

  /** The spare deck stops preloading: queue changed, next item not Audius/Solco, playback stopped. */
  const releaseSpare = useCallback(() => {
    decks.spare = null;
    releaseDeck(decks.spareDeck);
  }, [decks]);

  // Both decks: nothing audible and no preload left downloading. Inside a tap, the load() of each
  // deck also unlocks it on iOS (see primeMediaElement).
  const releaseAudio = useCallback(() => {
    try {
      ytPlayerRef.current?.pauseVideo();
    } catch {
      // The IFrame player may still be initialising.
    }
    releaseSpare();
    releaseDeck(decks.current);
  }, [decks, releaseSpare]);

  /**
   * Object URL of a local item's audio, made once from IndexedDB (no network) and reused until the
   * item is no longer current or prepared. 'missing': removed or evicted from this device.
   */
  const loadLocalSource = useCallback((track: MusicPlayerTrack): Promise<LocalSource> => {
    const id = localTrackId(track.qualifiedId);
    if (!id) return Promise.resolve({ ok: false, reason: 'missing' });
    const key = track.qualifiedId;
    const held = localAudioRef.current.get(key);
    if (held) return Promise.resolve({ ok: true, url: held.url });
    const pending = localLoadsRef.current.get(key);
    if (pending) return pending;
    // Still wanted when it lands: not dropped by forgetLocalTracks (file removed meanwhile).
    const settle = () => {
      const wanted = localLoadsRef.current.get(key) === load;
      if (wanted) localLoadsRef.current.delete(key);
      return wanted;
    };
    const load: Promise<LocalSource> = createObjectUrlForTrack(id).then(
      (handle): LocalSource => {
        const wanted = settle();
        if (!handle) return { ok: false, reason: 'missing' };
        if (unmountedRef.current || !wanted) {
          handle.revoke();
          return { ok: false, reason: wanted ? 'unavailable' : 'missing' };
        }
        localAudioRef.current.set(key, handle);
        return { ok: true, url: handle.url };
      },
      (): LocalSource => {
        // IndexedDB unavailable or failing (private mode, storage error).
        settle();
        return { ok: false, reason: 'unavailable' };
      },
    );
    localLoadsRef.current.set(key, load);
    return load;
  }, []);

  /** Revokes the local object URLs no longer needed: only `keep` (qualifiedIds) survive. */
  const pruneLocalSources = useCallback((keep: ReadonlySet<string>) => {
    for (const [key, handle] of localAudioRef.current) {
      if (keep.has(key)) continue;
      handle.revoke();
      localAudioRef.current.delete(key);
    }
  }, []);

  /**
   * Aggiorna il conteggio del brano a cui si riferisce il permesso: quello dei brani in evidenza
   * (30 al mese) o quello del catalogo (40: Audius, podcast, audio.com; le fonti esenti ricevono
   * comunque i numeri del catalogo). I due conteggi restano separati anche nell'istantanea usata
   * per prevedere il brano successivo (predictPlayBlock).
   */
  const applyPermit = useCallback((permit: PlayPermit, qualifiedId: string) => {
    const featured = isFeaturedPlayId(qualifiedId);
    if (permit.used !== undefined) (featured ? setFeaturedPlaysUsed : setPlaysUsed)(permit.used);
    if (permit.limit !== undefined) {
      (featured ? setFeaturedPlaysLimit : setPlaysLimit)(permit.limit);
    }
    setPlayBlock(permit.allowed ? null : (permit.reason ?? null));
    const known = accessRef.current;
    if (known && permit.used !== undefined) {
      accessRef.current = featured
        ? {
            ...known,
            featuredPlaysUsed: permit.used,
            featuredPlaysLimit:
              permit.limit === undefined ? known.featuredPlaysLimit : permit.limit,
          }
        : {
            ...known,
            playsUsed: permit.used,
            playsLimit: permit.limit === undefined ? known.playsLimit : permit.limit,
          };
    }
  }, []);

  // Premium state and Free counters (GET /api/music/access: never consumes a play).
  const loadAccess = useCallback(
    () =>
      fetch('/api/music/access', { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<AccessBody>) : null))
        .then((body) => {
          setPremium(body?.premium === true);
          setSignedIn(body?.signedIn === true);
          setPlaysUsed(numberOrNull(body?.playsUsed));
          setPlaysLimit(numberOrNull(body?.playsLimit));
          setFeaturedPlaysUsed(numberOrNull(body?.featuredPlaysUsed));
          setFeaturedPlaysLimit(numberOrNull(body?.featuredPlaysLimit));
          accessRef.current = body ? accessSnapshot(body) : null;
          return accessRef.current;
        })
        .catch(() => {
          setPremium((value) => value ?? false);
          return null;
        }),
    [],
  );

  // Lock screen, Control Center and Android notification: metadata set once per item.
  const showNowPlayingRef = useRef<(track: ActiveTrack | null) => void>(() => undefined);
  const showNowPlaying = useCallback((track: ActiveTrack | null) => {
    const session = mediaSessionOrNull();
    if (!session) return;
    if (!track) {
      nowPlayingRef.current = null;
      session.metadata = null;
      return;
    }
    // A local file: its own album tag and the cover's object URL (null until it is read).
    const local = isLocalTrack(track);
    const held = localArtworkRef.current;
    const artwork = local
      ? held?.qualifiedId === track.qualifiedId
        ? held.url
        : null
      : track.artworkUrl;
    const album = local ? track.album || track.sourceLabel : track.sourceLabel;
    // Copertina servita da Solco (brani in evidenza): può non esistere (file senza copertina).
    // Finché non è confermata, sulla schermata di blocco va l'icona di Solco, poi la copertina.
    const shownArtwork = local
      ? artwork
      : verifiedCover(artwork, () => {
          const current = currentTrackRef.current;
          if (current?.qualifiedId === track.qualifiedId) showNowPlayingRef.current(current);
        });
    const key = `${track.qualifiedId}|${track.title}|${shownArtwork ?? ''}|${album}`;
    if (nowPlayingRef.current === key) return;
    nowPlayingRef.current = key;
    try {
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artistName,
        album,
        artwork: mediaArtwork(shownArtwork),
      });
    } catch {
      session.metadata = null;
    }
  }, []);
  showNowPlayingRef.current = showNowPlaying;

  // Increases on every play request; a slow lookup for an older request is ignored.
  const playRequestRef = useRef(0);
  // Imported songs not found on YouTube in a row (auto-skip stops after a full lap).
  const missStreakRef = useRef(0);
  // Set every render below (needs followingIndex/playQueueIndex, defined later).
  const skipMissingRef = useRef<() => void>(() => undefined);
  // On-demand item that never started (qualifiedId): the next one starts (set every render below).
  const skipUnavailableRef = useRef<(qualifiedId: string) => void>(() => undefined);
  // Live radio stuck waiting for data (see watchLiveStall; set every render below).
  const stallRecoveryRef = useRef<(request: number, position: number) => void>(() => undefined);
  // Risolve true se l'elemento è partito davvero (o è passato al player ufficiale YouTube), false
  // se è stato bloccato, rifiutato, rimandato o non è riproducibile (vedi "Ascolta in background").
  const playCurrentTrack = useCallback(
    async (requested: ActiveTrack, options?: { reconnect?: boolean }): Promise<boolean> => {
      let track = requested;
      const request = ++playRequestRef.current;
      // Un avvio nuovo (Play, altro elemento) ricomincia i tentativi di riconnessione della diretta:
      // solo il timer di reconnectLive li continua.
      if (!options?.reconnect) reconnectsRef.current = 0;
      // Un nuovo avvio: la ripresa automatica al ritorno della rete/primo piano non serve più.
      offlineResumeRef.current = null;
      dropResumeRef.current = null;
      if ((track.playbackMode === 'song' || isYouTubeTrack(track)) && isPageHidden()) {
        // YouTube never starts while Solco is hidden (API terms): it waits for the listener.
        decks.current?.pause();
        deferredVideoRef.current = track.qualifiedId;
        setPlayBlock(null);
        setErrorMessage(YOUTUBE_HIDDEN_NOTICE);
        setStatus('paused');
        setSessionPlaybackState('paused');
        return false;
      }
      deferredVideoRef.current = null;
      if (track.playbackMode === 'song') {
        decks.current?.pause();
        setErrorMessage(null);
        setPlayBlock(null);
        setStatus('loading');
        setElapsedSeconds(0);
        setDurationSeconds(track.durationSeconds ?? 0);
        const resolved = await resolveSongTrack(track);
        // The listener picked something else (or closed the player) while we were searching.
        if (request !== playRequestRef.current) return false;
        if (!resolved.ok) {
          setStatus('error');
          setErrorMessage(resolved.message);
          // Not on YouTube: move on to the next song instead of stopping the playlist. Quota
          // or network problems do not skip (the next song would fail the same way).
          if (resolved.notFound) skipMissingRef.current();
          return false;
        }
        // Il conteggio dei fallimenti di fila NON si azzera qui: un brano trovato può avere un
        // video che non parte (onError). Lo azzera solo un elemento che suona davvero (onPlaying),
        // altrimenti con «Ripeti tutta la coda» i video non riproducibili girerebbero all'infinito.
        // Swap the song for its video in the queue: previous/next keep working.
        const songId = track.qualifiedId;
        setQueue((items) =>
          items.map((item) => (item.qualifiedId === songId ? resolved.track : item)),
        );
        setCurrentTrack(resolved.track);
        track = resolved.track;
      }
      if (isYouTubeTrack(track)) {
        decks.current?.pause();
        // The 'playback' audio session is for Solco's own audio, never for YouTube.
        releasePlaybackSession();
        setErrorMessage(null);
        setPlayBlock(null);
        setStatus('loading');
        setElapsedSeconds(0);
        setDurationSeconds(track.durationSeconds ?? 0);
        const permit = await requestPlayPermit(track.qualifiedId);
        if (request !== playRequestRef.current) return false;
        applyPermit(permit, track.qualifiedId);
        if (!permit.allowed) {
          // Avvio rifiutato: annulla anche la creazione del player ufficiale ancora in corso, che
          // con autoplay farebbe partire il video comunque (vedi l'effetto del motore YouTube).
          playRequestRef.current += 1;
          try {
            ytPlayerRef.current?.pauseVideo();
          } catch {
            // Player not ready.
          }
          setStatus('idle');
          return false;
        }
        // The engine effect loads the video once the visible dock is mounted.
        setYtRequest((value) => value + 1);
        return true;
      }
      const audio = decks.current;
      if (!audio) return false;
      setPreviewEnded(false);
      setPlayBlock(null);
      setErrorMessage(null);
      setStatus('loading');
      setElapsedSeconds(0);
      setDurationSeconds(isLiveTrack(track) ? 0 : (track.durationSeconds ?? 0));
      mediaRetryRef.current = 0;
      retryPositionRef.current = 0;
      restartListeningSample(listeningRef.current);
      audio.pause();
      audio.preload = 'none';
      if (isLocalTrack(track)) {
        // The listener's own file: no permit, rights check, Free counter or login, and nothing
        // about it is sent anywhere. The element was unlocked inside the tap (releaseAudio's load()
        // on iOS), so play() still works after this IndexedDB read.
        const source = await loadLocalSource(track);
        if (request !== playRequestRef.current) return false;
        if (!source.ok) {
          // Removed or evicted from this device: say so, then the next item (see skipLocalRef).
          const message =
            source.reason === 'missing' ? LOCAL_MISSING_MESSAGE : LOCAL_UNAVAILABLE_MESSAGE;
          releaseAudio();
          setStatus('error');
          setErrorMessage(message);
          setLocalSkip({ qualifiedId: track.qualifiedId, request, message });
          return false;
        }
        declarePlaybackSession();
        audio.src = source.url;
        audio.load();
        const playing = audio.play();
        showNowPlaying(track);
        try {
          await playing;
          if (request !== playRequestRef.current) return false;
          setStatus('playing');
          return true;
        } catch (error) {
          if (request !== playRequestRef.current) return false;
          if (startHeldBack(error, audio)) {
            // No tap to start from (e.g. a lock-screen press after a reload), or a system pause
            // while it was starting: paused, never stuck on 'loading'; the next press resumes it.
            setStatus('paused');
            setSessionPlaybackState('paused');
            return false;
          }
          // Elemento già svuotato da chi gestisce il suo errore (handleLocalError).
          if (isDomError(error, 'AbortError')) return false;
          // A file the browser cannot decode arrives through the element's 'error' event too.
          setStatus('error');
          setErrorMessage(LOCAL_UNPLAYABLE_MESSAGE);
          return false;
        }
      }
      try {
        // Check Audius's stream authorization before requesting audio bytes.
        // Open streams start synchronously inside the tap: iOS Safari blocks play() after an await.
        // The permit request runs alongside: open streams must start inside the tap (iOS).
        const permitRequest = requestPlayPermit(track.qualifiedId);
        // audio.com è uno stream aperto, ma nessuna route di Solco lo vede: l'audio parte solo
        // dopo il sì del permesso (che registra l'ascolto), così un ospite o un account Free oltre
        // il limite non ne sentono nemmeno un istante. Come per Audius, il load() di releaseAudio
        // dentro il tocco ha già sbloccato l'elemento su iOS: play() dopo l'attesa funziona.
        // Anche i brani in evidenza aspettano il permesso (solo verifica: la loro route di stream
        // rifiuterebbe comunque oltre i 30 avvii Free del mese), così il blocco si mostra subito,
        // senza una richiesta di stream destinata al 402.
        if (
          !isOpenStream(track) ||
          permitRecordsPlay(track.qualifiedId) ||
          isFeaturedPlayId(track.qualifiedId)
        ) {
          // Permesso e verifica dei diritti partono insieme (non dipendono l'uno dall'altra): un
          // giro di rete in meno prima del primo byte. Il rifiuto della verifica si legge dopo.
          const rightsCheck = verifyPlayback(track).then(
            () => null,
            (error: unknown) => error ?? new Error('Playback check failed'),
          );
          const early = await permitRequest;
          if (request !== playRequestRef.current) return false;
          applyPermit(early, track.qualifiedId);
          if (!early.allowed) {
            releaseAudio();
            if (early.unconfirmed) {
              // Permesso di audio.com non confermato (rete, registro degli ascolti): il motivo,
              // senza saltare al successivo (fallirebbe allo stesso modo).
              setStatus('error');
              setErrorMessage(PLAY_PERMIT_UNCONFIRMED_MESSAGE);
            } else {
              setStatus('idle');
            }
            return false;
          }
          // Nessuna verifica /playback per gli stream aperti (audio.com compreso): ritorna subito.
          const rightsError = await rightsCheck;
          if (request !== playRequestRef.current) return false;
          if (rightsError) throw rightsError;
        }
        // iOS: declare a music session right before play() (Apple: activate when playback starts).
        declarePlaybackSession();
        audio.src = track.streamPath;
        audio.load();
        const playing = audio.play();
        showNowPlaying(track);
        const permit = await permitRequest;
        if (request !== playRequestRef.current) {
          playing.catch(() => undefined);
          return false;
        }
        applyPermit(permit, track.qualifiedId);
        if (!permit.allowed) {
          playing.catch(() => undefined);
          releaseAudio();
          setStatus('idle');
          return false;
        }
        await playing;
        if (request !== playRequestRef.current) return false;
        setStatus('playing');
        return true;
      } catch (error) {
        // A newer request owns the audio element now: leave it alone.
        if (request !== playRequestRef.current) return false;
        if (startHeldBack(error, audio)) {
          // Non è uno stream fallito: iOS ha rifiutato play() arrivato dopo le attese di rete
          // (pagina in background, es. «successivo» dalla schermata di blocco o una riconnessione
          // a tempo) oppure il sistema l'ha messo in pausa mentre partiva. La sorgente resta: il
          // prossimo Play riparte subito dentro il tocco (resumeElement), senza altre attese.
          setStatus('paused');
          setSessionPlaybackState('paused');
          return false;
        }
        // Elemento già svuotato da handleError, che ha già mostrato il motivo giusto.
        if (isDomError(error, 'AbortError')) return false;
        releaseAudio();
        setStatus('error');
        setErrorMessage(failureMessage(error, track));
        return false;
      }
    },
    [applyPermit, decks, loadLocalSource, releaseAudio, setElapsedSeconds, showNowPlaying],
  );

  const playTrack = useCallback(
    async (
      requested: MusicPlayerTrack,
      streamPath: string,
      requestedQueue: MusicPlayerTrack[] = [requested],
    ): Promise<boolean> => {
      // Brani di audio.com con l'id storico: entrano in coda con l'id di oggi (withCurrentPlayId).
      const track = withCurrentPlayId(requested);
      const nextQueue = requestedQueue.map(withCurrentPlayId);
      // A local file has no stream path: the caller passes '' (see local-tracks.ts).
      const safePath = isLocalTrack(track)
        ? trackStreamPath(track)
        : safeStreamPath(streamPath, track);
      if (!safePath || !trackStreamPath(track)) {
        releaseAudio();
        setStatus('error');
        setErrorMessage(
          isAudioComTrack(track)
            ? AUDIOCOM_STREAM_EXPIRED_MESSAGE
            : 'Il brano non ha un percorso Audius verificabile.',
        );
        return false;
      }
      // Local files: the player makes (and revokes) their covers itself, and they link nowhere.
      const deviceOnly = (item: MusicPlayerTrack): MusicPlayerTrack =>
        isLocalTrack(item)
          ? { ...item, artworkUrl: null, artistUrl: null, sourceUrl: null, importedFrom: null }
          : item;
      const candidateQueue = nextQueue
        .map((item) => {
          const itemPath = trackStreamPath(item);
          return itemPath ? { ...deviceOnly(item), streamPath: itemPath } : null;
        })
        .filter((item): item is ActiveTrack => item !== null);
      const selectedTrack = { ...deviceOnly(track), streamPath: safePath };
      const selectedIndex = candidateQueue.findIndex(
        (item) => item.qualifiedId === track.qualifiedId,
      );
      if (selectedIndex < 0) candidateQueue.unshift(selectedTrack);
      const actualIndex = selectedIndex < 0 ? 0 : selectedIndex;
      candidateQueue[actualIndex] = selectedTrack;
      releaseAudio();
      recordedRef.current = null;
      nextPlanRef.current = null;
      preparedRef.current = null;
      // Il punto di ripresa salvato (coda ripristinata, errore) era di un altro brano o della coda
      // di prima: il brano scelto parte dall'inizio.
      pendingSeekRef.current = null;
      // A new queue is a new lap: skipping missing items starts counting again.
      missStreakRef.current = 0;
      // A new queue: the official player gets a fresh playlist (or video), as before runs existed.
      ytRunRef.current = null;
      ytAtRef.current = null;
      ytPendingRef.current = null;
      setQueue(candidateQueue);
      setQueueIndex(actualIndex);
      setCurrentTrack(selectedTrack);
      return playCurrentTrack(selectedTrack);
    },
    [playCurrentTrack, releaseAudio],
  );

  // Switch inside the YouTube playlist already loaded in the official player (set every render).
  const moveInRunRef = useRef<(index: number) => boolean>(() => false);

  const playQueueIndex = useCallback(
    async (index: number) => {
      const next = queue[index];
      if (!next) return;
      // A video of the playlist loaded in the official player: nextVideo / previousVideo /
      // playVideoAt, no reload (YouTube has the next videos ready).
      if (moveInRunRef.current(index)) return;
      releaseAudio();
      recordedRef.current = null;
      // Un altro elemento della coda: nessun punto di ripresa di quello di prima.
      pendingSeekRef.current = null;
      // YouTube may report the video it was advancing to meanwhile: the app's choice wins.
      if (ytRunRef.current) ytPendingRef.current = { index, from: queueIndexRef.current };
      setQueueIndex(index);
      setCurrentTrack(next);
      await playCurrentTrack(next);
    },
    [playCurrentTrack, queue, releaseAudio],
  );

  // The next item is chosen once per current item (shuffle included), so what was prepared ahead
  // is what plays. While Solco is hidden, YouTube items are skipped when an audio item follows.
  const followingIndex = useCallback(
    // `from`: another starting item than the current one (a video YouTube moved to by itself).
    (wrap: boolean, from: number = queueIndex) => {
      if (queue.length === 0 || from < 0) return null;
      const key = `${from}|${queue[from]?.qualifiedId ?? ''}|${queue.length}|${shuffle}|${wrap}`;
      const hidden = isPageHidden();
      const plan = nextPlanRef.current;
      if (
        plan &&
        plan.key === key &&
        (plan.index === null || !hidden || playsWhileHidden(queue[plan.index]?.playbackMode)) &&
        // In ordine (non casuale), una scelta fatta a pagina nascosta ha saltato i video YouTube:
        // con Solco di nuovo visibile si rifà, così il video in coda non viene saltato.
        (shuffle || !plan.hidden || hidden)
      ) {
        return plan.index;
      }
      const index = pickNextIndex({
        modes: queue.map((item) => item.playbackMode),
        index: from,
        shuffle,
        wrap,
        hidden,
      });
      nextPlanRef.current = { key, index, hidden };
      return index;
    },
    [queue, queueIndex, shuffle],
  );

  // Synchronous switch to a queue item when it is safe (set every render, see advanceTo below).
  const advanceRef = useRef<(index: number) => boolean>(() => false);
  // Latest play/pause logic for the buttons, lock screen, notification and headset (set every render).
  const controlsRef = useRef<{
    status: PlaybackStatus;
    pause: () => void;
    resume: () => Promise<unknown> | undefined;
  }>({ status: 'idle', pause: () => undefined, resume: () => undefined });

  const previousTrack = useCallback(async () => {
    const yt = ytPlayerRef.current;
    if (isYouTubeTrack(currentTrack) && yt && yt.getCurrentTime() > 5) {
      yt.seekTo(0, true);
      setElapsedSeconds(0);
      return;
    }
    const audio = decks.current;
    if (audio && !isLiveTrack(currentTrack) && audio.currentTime > 5) {
      audio.currentTime = 0;
      setElapsedSeconds(0);
      return;
    }
    if (queueIndex > 0 && !advanceRef.current(queueIndex - 1)) {
      await playQueueIndex(queueIndex - 1);
    }
  }, [currentTrack, decks, playQueueIndex, queueIndex, setElapsedSeconds]);

  const nextTrack = useCallback(async () => {
    const index = followingIndex(repeat === 'all');
    if (index !== null && !advanceRef.current(index)) await playQueueIndex(index);
  }, [followingIndex, playQueueIndex, repeat]);

  const togglePlayback = useCallback(async () => {
    const controls = controlsRef.current;
    if (controls.status === 'playing') controls.pause();
    else await controls.resume();
  }, []);

  const seekTo = useCallback(
    (seconds: number) => {
      if (isYouTubeTrack(currentTrack)) {
        if (!Number.isFinite(seconds) || seconds < 0) return;
        ytPlayerRef.current?.seekTo(seconds, true);
        setElapsedSeconds(seconds);
        return;
      }
      const audio = decks.current;
      if (
        !audio ||
        isLiveTrack(currentTrack) ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        !Number.isFinite(audio.duration)
      )
        return;
      audio.currentTime = Math.min(seconds, audio.duration);
      setElapsedSeconds(audio.currentTime);
    },
    [currentTrack, decks, setElapsedSeconds],
  );

  // Tempo dell'audio per il pannello del testo: lo legge da sé (polling), senza altri render qui.
  const getLyricsTime = useCallback(() => decks.current?.currentTime ?? 0, [decks]);

  const stopPlayback = useCallback(() => {
    // Cancel any lookup, permit or radio reconnect still pending: closing must not bring it back.
    playRequestRef.current += 1;
    clearTimer(reconnectTimerRef);
    clearTimer(stallTimerRef);
    missStreakRef.current = 0;
    pendingSeekRef.current = null;
    offlineResumeRef.current = null;
    dropResumeRef.current = null;
    releaseAudio();
    // Nothing plays any more: no object URL of the listener's files is kept.
    pruneLocalSources(new Set());
    setCurrentTrack(null);
    setQueue([]);
    setQueueIndex(-1);
    setStatus('idle');
    setElapsedSeconds(0);
    setDurationSeconds(0);
    setErrorMessage(null);
    setExpanded(false);
    setPreviewEnded(false);
    setBuffering(false);
    deferredVideoRef.current = null;
    nextPlanRef.current = null;
    preparedRef.current = null;
    // Like deactivating AVAudioSession: other apps may resume their audio.
    releasePlaybackSession();
    showNowPlaying(null);
    applyPositionState(mediaSessionOrNull(), null);
    setSessionPlaybackState('none');
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode): nothing to clear.
    }
  }, [pruneLocalSources, releaseAudio, setElapsedSeconds, showNowPlaying]);

  // Al logout (o al cambio account) ferma e svuota il player. Il muro di login lascia montato il
  // player sulle rotte pubbliche (es. /login, dove porta "Esci" dalla dashboard), quindi senza
  // questo l'audio continuerebbe a suonare dopo l'uscita. La musica richiede comunque l'accesso e
  // la route di streaming ricontrolla sessione e quota a ogni richiesta: qui fermiamo l'elemento.
  const { data: authSession, isPending: authPending, error: authError } = useSession();
  const authUserId = authSession?.user?.id ?? null;
  // Sessione nota: risposta del server ricevuta (con o senza utente). Un errore di rete al primo
  // caricamento lascia `data` vuoto: in quel caso non si può sapere di chi sia la coda salvata.
  const authKnown = !authPending && (authUserId !== null || !authError);
  const previousUserIdRef = useRef<string | null>(null);
  const authResolvedRef = useRef(false);
  useEffect(() => {
    // Durante una verifica/refresh della sessione non decidiamo nulla: evita falsi logout.
    if (authPending) return;
    const previousUserId = previousUserIdRef.current;
    // Transizione da un utente a nessuno (logout) o a un altro utente (cambio account): stop.
    if (authResolvedRef.current && previousUserId !== null && previousUserId !== authUserId) {
      stopPlayback();
    }
    // Accesso, uscita o cambio account senza ricaricare la pagina (es. accesso con email): Premium e
    // contatori Free seguono l'account, quindi si rileggono (il primo controllo lo fa il montaggio).
    if (authResolvedRef.current && previousUserId !== authUserId) void loadAccess();
    previousUserIdRef.current = authUserId;
    authResolvedRef.current = true;
  }, [authUserId, authPending, stopPlayback, loadAccess]);

  // "Esci" (signOutAndStopMusic): fermati subito, PRIMA che la sessione cambi e prima che il muro di
  // login smonti il player. stopPlayback dimentica anche la coda salvata e svuota la Media Session.
  useEffect(() => {
    const stop = () => stopPlayback();
    window.addEventListener(STOP_PLAYER_EVENT, stop);
    return () => window.removeEventListener(STOP_PLAYER_EVENT, stop);
  }, [stopPlayback]);

  // First statement of a tap that will start audio after a network wait (see MusicPlayerValue).
  // Only unlocks the element: the 'playback' session is declared right before play(), so a search
  // that finds nothing leaves it untouched while the YouTube video goes on.
  const isCurrentTrack = useCallback(
    (qualifiedId: string) => currentTrackRef.current?.qualifiedId === qualifiedId,
    [],
  );

  const replaceCurrentTrack = useCallback(
    (requested: MusicPlayerTrack, streamPath: string) => {
      const track = withCurrentPlayId(requested);
      const items = queueRef.current;
      const index = queueIndexRef.current;
      // Il brano trovato prende il posto di quello corrente; altre sue copie nella coda (rare)
      // si tolgono, così playTrack lo ritrova proprio in questo punto.
      const nextQueue =
        index >= 0 && index < items.length
          ? items.flatMap((item, at) =>
              at === index ? [track] : item.qualifiedId === track.qualifiedId ? [] : [item],
            )
          : [track];
      return playTrack(track, streamPath, nextQueue);
    },
    [playTrack],
  );

  const primeAudio = useCallback(() => {
    primeMediaElement(decks.current);
    // The spare deck too: on iOS each element is unlocked by its own load() inside a tap.
    primeMediaElement(decks.spareDeck);
  }, [decks]);

  /** Pause from a button, the lock screen, the notification or the headset. */
  const pausePlayback = () => {
    if (!currentTrack) return;
    if (isYouTubeTrack(currentTrack) && ytPlayerRef.current) {
      // Paused by the listener, before YouTube confirms it: locking the phone right after is not
      // a "stopped because you left" pause.
      ytPlayingRef.current = false;
      try {
        ytPlayerRef.current.pauseVideo();
      } catch {
        // Player not ready.
      }
      if (status === 'loading') {
        // In pausa mentre il player ufficiale si prepara (non ancora pronto, pauseVideo ignorato):
        // il suo onReady non deve poi far partire il video con l'autoplay.
        playRequestRef.current += 1;
        setStatus('paused');
        setSessionPlaybackState('paused');
      }
      return;
    }
    // Paused while the next item was starting: cancel that start, do not restart it.
    if (status === 'loading') playRequestRef.current += 1;
    resumeRequestRef.current = null;
    clearTimer(reconnectTimerRef);
    decks.current?.pause();
    setStatus('paused');
    setBuffering(false);
    setSessionPlaybackState('paused');
  };

  /**
   * Resume a paused on-demand item: play() first, inside the tap or the lock-screen press (iOS
   * drops a play() that follows a network wait), and re-check access in parallel. The stream
   * route re-checks rights and the Free quota on every request, so the client check only stops the
   * audio and explains why when access was withdrawn meanwhile (e.g. Solco Pro expired).
   */
  const resumeElement = (track: ActiveTrack, audio: HTMLAudioElement) => {
    const request = playRequestRef.current;
    resumeRequestRef.current = request;
    declarePlaybackSession();
    setErrorMessage(null);
    audio.play().then(
      () => {
        if (request === playRequestRef.current) setStatus('playing');
      },
      (error: unknown) => {
        if (request !== playRequestRef.current || isDomError(error, 'AbortError')) return;
        if (isDomError(error, 'NotAllowedError')) {
          resumeRequestRef.current = null;
          setStatus('paused');
          return;
        }
        setStatus('error');
        setErrorMessage(playbackFailure(error, track));
        releaseAudio();
      },
    );
    // A local file never asks the server anything (verifyPlayback returns at once for it).
    verifyPlayback(track).catch((error: unknown) => {
      if (request !== playRequestRef.current) return;
      // Only a denial about this item (rights, Pro expired) stops it. A network error (phone just
      // woken, Wi-Fi ↔ mobile) or a transient reason (rate limit, catalogue or entitlement check
      // down) leaves the decision to the stream route, which enforces rights and quota anyway.
      if (rightsVerdictFromReason(denialReason(error)) !== 'denied') return;
      releaseAudio();
      setStatus('error');
      setErrorMessage(failureMessage(error, track));
    });
  };

  /** Play from a button, the lock screen, the notification or the headset. */
  const resumePlayback = (): Promise<unknown> | undefined => {
    const track = currentTrack;
    if (!track) return undefined;
    if (isYouTubeTrack(track) || track.playbackMode === 'song') {
      // YouTube is never started from the lock screen or a background tab.
      if (isPageHidden()) return undefined;
      if (
        isYouTubeTrack(track) &&
        ytPlayerRef.current &&
        deferredVideoRef.current !== track.qualifiedId
      ) {
        ytPlayerRef.current.playVideo();
        return undefined;
      }
      return playCurrentTrack(track);
    }
    const audio = decks.current;
    if (!audio) return undefined;
    // A tap or a lock-screen press: unlock idle decks now (no await before this), so the spare can
    // start the next track on its own later (e.g. a queue restored after a reload).
    primeMediaElement(audio);
    primeMediaElement(decks.spareDeck);
    const hasSource = Boolean(audio.getAttribute('src'));
    if (status === 'loading') {
      // Already starting (e.g. play pressed on the lock screen between two tracks).
      if (hasSource) audio.play().catch(() => undefined);
      return undefined;
    }
    if (
      hasSource &&
      !previewEnded &&
      // A paused live stream would resume from stale buffered audio: reconnect instead.
      !isLiveTrack(track) &&
      (status === 'paused' || status === 'playing')
    ) {
      resumeElement(track, audio);
      return undefined;
    }
    return playCurrentTrack(track);
  };

  controlsRef.current = { status, pause: pausePlayback, resume: resumePlayback };

  const toggleShuffle = useCallback(() => setShuffle((value) => !value), []);
  const cycleRepeat = useCallback(
    () => setRepeat((value) => (value === 'off' ? 'all' : value === 'all' ? 'one' : 'off')),
    [],
  );

  const autoplay = useAutoplay();
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  const toggleAutoplay = useCallback(() => setAutoplay(!autoplayRef.current), []);
  // Brani già visti dall'autoplay in questa sessione: niente ripetizioni immediate.
  const autoplaySeenRef = useRef<Set<string>>(new Set());
  // Evita continuazioni concorrenti: la richiesta (playRequestRef) per cui una è in corso.
  const autoplayBusyRef = useRef<number | null>(null);
  // Lotto dell'autoplay preparato ~20 s prima della fine della coda (vedi prepareAutoplay), per il
  // brano `from` ("indice|qualifiedId"), e l'ultimo brano per cui si è tentata la preparazione.
  const autoplayNextRef = useRef<{
    from: string;
    picks: ActiveTrack[];
    rights: RightsVerdict;
  } | null>(null);
  const autoplayPrepRef = useRef<string | null>(null);

  const live = isLiveTrack(currentTrack);
  const hasNext =
    queueIndex >= 0 &&
    (queueIndex < queue.length - 1 || ((repeat === 'all' || shuffle) && queue.length > 1));
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;
  // "Il video si è fermato…" when the listener comes back (see background-switch-notice.tsx).
  const currentVideoId =
    currentTrack && isYouTubeTrack(currentTrack) ? youtubeVideoId(currentTrack) : null;
  const {
    noticeVideoId,
    markHiddenPause,
    dismiss: dismissReturnNotice,
  } = useReturnNotice(currentVideoId);

  /** Rewards: one minute per POST, measured on the media clock (see listening-time.ts). */
  const sendListening = (seconds: number) => {
    const clock = listeningRef.current;
    // The listener's own files never earn rewards (the body names no item: only this check).
    const playing = currentTrackRef.current;
    if (playing && isDeviceOnly(playing)) return;
    try {
      fetch('/api/rewards', {
        method: 'POST',
        credentials: 'same-origin',
        // Completes even if the page is frozen or closed right after (locked phone, app switch).
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'listen', seconds }),
      }).catch(() => restoreListening(clock, seconds));
    } catch {
      restoreListening(clock, seconds);
    }
  };

  const forgetLocalTracks = useCallback(
    (ids: readonly string[] | 'all') => {
      const forgets = (qualifiedId: string) => {
        const id = localTrackId(qualifiedId);
        return id !== null && (ids === 'all' || ids.includes(id));
      };
      const playing = currentTrackRef.current;
      if (playing && isDeviceOnly(playing) && forgets(playing.qualifiedId)) {
        stopPlayback();
        return;
      }
      // Object URLs made for them (the prepared next item), and reads still running.
      let held = false;
      for (const [key, handle] of localAudioRef.current) {
        if (!forgets(key)) continue;
        handle.revoke();
        localAudioRef.current.delete(key);
        held = true;
      }
      for (const key of [...localLoadsRef.current.keys()]) {
        if (forgets(key)) localLoadsRef.current.delete(key);
      }
      const items = queueRef.current;
      const removed = items.flatMap((item, index) =>
        isDeviceOnly(item) && forgets(item.qualifiedId) ? [index] : [],
      );
      if (removed.length === 0 && !held) return;
      // The spare may hold one of them; its index changes anyway. prepareNext runs again.
      releaseSpare();
      nextPlanRef.current = null;
      preparedRef.current = null;
      if (removed.length === 0) return;
      const gone = new Set(removed);
      const shift = (index: number) => index - removed.filter((at) => at < index).length;
      const kept = items.filter((_, index) => !gone.has(index));
      const index = queueIndexRef.current < 0 ? -1 : shift(queueIndexRef.current);
      // YouTube playlist runs hold no local item: only their place in the queue moves.
      const run = ytRunRef.current;
      if (run) ytRunRef.current = { ...run, start: shift(run.start) };
      const at = ytAtRef.current;
      if (at) ytAtRef.current = { ...at, index: shift(at.index) };
      const pending = ytPendingRef.current;
      if (pending) {
        ytPendingRef.current = gone.has(pending.index)
          ? null
          : {
              index: shift(pending.index),
              from: pending.from === null || gone.has(pending.from) ? null : shift(pending.from),
            };
      }
      queueRef.current = kept;
      queueIndexRef.current = index;
      setQueue(kept);
      setQueueIndex(index);
    },
    [releaseSpare, stopPlayback],
  );

  /**
   * First seconds of the next Audius/Solco track on the spare deck, once its rights are verified
   * and no Free-plan block is predicted. The stream answers a Range from byte 0 with the first
   * chunk only and records no play for it; the play counts when the track really continues.
   * preloadDeck uses preload='metadata' (never 'auto'), so a paused spare never asks for that
   * counted continuation by itself.
   *
   * A local file (`localUrl`: its object URL) is preloaded the same way: nothing is asked of the
   * server and nothing can block it, so only the plan (next item, no repeat one) matters.
   */
  const dataSaver = useDataSaver();
  const dataSaverRef = useRef(dataSaver);
  dataSaverRef.current = dataSaver;
  const preloadOnSpare = (
    index: number,
    next: ActiveTrack,
    rights: RightsVerdict,
    localUrl: string | null = null,
  ) => {
    const spare = decks.spareDeck;
    if (!spare) return;
    // Risparmio dati: non precaricare in anticipo l'audio del brano successivo.
    if (dataSaverRef.current) {
      releaseSpare();
      return;
    }
    const planned = repeat === 'one' ? null : followingIndex(repeat === 'all');
    const wantsPreload =
      localUrl !== null
        ? GAPLESS_DECKS_ENABLED && repeat !== 'one'
        : wantsSparePreload({
            enabled: GAPLESS_DECKS_ENABLED,
            mode: next.playbackMode,
            repeatOne: repeat === 'one',
            decision: decideAdvance({
              mode: next.playbackMode,
              qualifiedId: next.qualifiedId,
              rights,
              access: accessRef.current,
              replay: isReplay(startedAtRef.current, next.qualifiedId, Date.now()),
            }),
          });
    if (planned !== index || queue[index]?.qualifiedId !== next.qualifiedId || !wantsPreload) {
      releaseSpare();
      return;
    }
    const src = localUrl ?? next.streamPath;
    const wanted: SpareLoad = { index, qualifiedId: next.qualifiedId, src };
    if (sameSpareLoad(decks.spare, wanted)) return;
    // A new src + load() also aborts whatever the spare was loading before.
    decks.spare = wanted;
    preloadDeck(spare, src);
  };
  // Latest queue/repeat for the preload decided when the checks answer (set every render).
  const preloadOnSpareRef = useRef(preloadOnSpare);
  preloadOnSpareRef.current = preloadOnSpare;

  // About 20 s before the end: freeze the next item and check it with requests that never
  // consume a Free play (rights: GET …/playback; quota: GET /api/music/access); warm its artwork.
  // Then the spare deck preloads its first seconds (Audius/Solco only, see preloadOnSpare).
  /**
   * Autoplay continuo, fine coda: ~20 s prima della fine si preparano il lotto che segue (Audius
   * trending), i diritti del primo brano e il limite Free, con richieste che non consumano ascolti.
   * A 'ended' il primo parte così nello stesso evento (startPreparedAutoplay), senza tre attese di
   * rete in silenzio: iOS sospende una pagina bloccata che tace. Se qualcosa manca, a fine coda resta
   * il percorso con la rete (continueAutoplay).
   */
  const prepareAutoplay = () => {
    if (!currentTrack || isLiveTrack(currentTrack)) return;
    const from = `${queueIndex}|${currentTrack.qualifiedId}`;
    // Un tentativo per brano, anche se fallisce: timeupdate arriva ~4 volte al secondo e un errore
    // non deve diventare una raffica di richieste (a fine brano resta il percorso con la rete).
    if (autoplayPrepRef.current === from) return;
    autoplayPrepRef.current = from;
    const request = playRequestRef.current;
    const seen = new Set(autoplaySeenRef.current);
    for (const item of queue) seen.add(item.qualifiedId);
    void (async () => {
      try {
        const data = await apiFetch('/api/music/trending', {
          schema: MusicTrendingResponseSchema,
          signal: AbortSignal.timeout(AUTOPLAY_FETCH_TIMEOUT_MS),
        });
        if (request !== playRequestRef.current) return;
        const picks = selectAutoplayCandidates(data.tracks, seen, AUTOPLAY_BATCH)
          .map(audiusResultToTrack)
          .flatMap((track): ActiveTrack[] => {
            const path = trackStreamPath(track);
            return path ? [{ ...track, streamPath: path }] : [];
          });
        const first = picks[0];
        if (!first) return;
        const [rights] = await Promise.all([prefetchRights(first), loadAccess()]);
        if (request !== playRequestRef.current) return;
        autoplayNextRef.current = { from, picks, rights };
      } catch {
        // Lotto non disponibile adesso: a fine coda resta il percorso con la rete.
      }
    })();
  };

  const prepareNext = () => {
    if (!currentTrack) return;
    const index = followingIndex(repeat === 'all');
    const next = index === null ? undefined : queue[index];
    if (index === null || !next) {
      // Ultimo elemento della coda con l'autoplay continuo acceso: si prepara il lotto che segue.
      if (index === null && autoplayRef.current && repeat !== 'one') prepareAutoplay();
      return;
    }
    // "Ripeti brano" loops this item: no object URL for a next file that will not play.
    if (repeat === 'one' && isLocalTrack(next)) return;
    const from = `${queueIndex}|${currentTrack.qualifiedId}`;
    const prepared = preparedRef.current;
    if (
      prepared &&
      prepared.from === from &&
      prepared.index === index &&
      prepared.qualifiedId === next.qualifiedId
    ) {
      return;
    }
    const entry: PreparedNext = { from, index, qualifiedId: next.qualifiedId, rights: 'pending' };
    preparedRef.current = entry;
    // The spare holds another track (shuffle or queue changed): no stray download.
    const wanted: SpareLoad = {
      index,
      qualifiedId: next.qualifiedId,
      src: deckSource(next, localAudioRef.current) ?? '',
    };
    if (decks.spare && !sameSpareLoad(decks.spare, wanted)) releaseSpare();
    if (isLocalTrack(next)) {
      // The listener's own file: its object URL is made now (IndexedDB, no network) and the spare
      // deck loads it, so 'ended' switches with no wait. Nothing is asked of the server. A missing
      // file stays 'pending': the normal path says so and skips it.
      void loadLocalSource(next).then((source) => {
        if (preparedRef.current !== entry || !source.ok) return;
        entry.rights = 'allowed';
        preloadOnSpareRef.current(index, next, 'allowed', source.url);
      });
      return;
    }
    if (next.artworkUrl) {
      try {
        const image = new window.Image();
        image.decoding = 'async';
        image.src = next.artworkUrl;
      } catch {
        // Artwork warm-up is best effort.
      }
    }
    if (!playsWhileHidden(next.playbackMode)) return;
    const rights: Promise<RightsVerdict> = needsRightsCheck(next.playbackMode)
      ? prefetchRights(next)
      : Promise.resolve('allowed');
    void Promise.all([rights, loadAccess()]).then(([verdict]) => {
      if (preparedRef.current !== entry) return;
      entry.rights = verdict;
      preloadOnSpareRef.current(index, next, verdict);
    });
  };

  /**
   * A local file added without a duration (iOS often reads no metadata when it is added): saved in
   * the library on this device once the element knows it. Once per file and session.
   */
  const rememberLocalDuration = (track: ActiveTrack, duration: number) => {
    if (track.durationSeconds != null || !Number.isFinite(duration) || duration <= 0) return;
    const id = localTrackId(track.qualifiedId);
    if (!id || localDurationsRef.current.has(id)) return;
    localDurationsRef.current.add(id);
    void setTrackDuration(id, duration).catch(() => undefined);
  };

  const handleTimeUpdate = () => {
    const audio = decks.current;
    if (!audio) return;
    if (audio.currentTime > 2) reconnectsRef.current = 0;
    if (mediaRetryRef.current > 0 && audio.currentTime > retryPositionRef.current + 30) {
      mediaRetryRef.current = 0;
      retryPositionRef.current = 0;
    }
    setElapsedSeconds(audio.currentTime);
    if (!isLiveTrack(currentTrack) && Number.isFinite(audio.duration))
      setDurationSeconds(audio.duration);
    // The listener's own files stay on the device: no history, recently played or rewards ticks.
    const local = isLocalTrack(currentTrack);
    if (local && currentTrack) rememberLocalDuration(currentTrack, audio.duration);
    if (
      currentTrack &&
      !local &&
      recordedRef.current !== currentTrack.qualifiedId &&
      audio.currentTime >= HISTORY_THRESHOLD_SECONDS
    ) {
      recordedRef.current = currentTrack.qualifiedId;
      recordPlay(currentTrack);
    }
    // Listening time for rewards (invites and "ascolta e guadagna"), from the seconds actually
    // played. YouTube videos never earn rewards: YouTube's policies forbid rewarding viewing.
    if (signedIn && currentTrack && !local && !isYouTubeTrack(currentTrack) && !audio.paused) {
      const seconds = observeListening(listeningRef.current, {
        position: audio.currentTime,
        nowMs: Date.now(),
      });
      if (seconds > 0) sendListening(seconds);
    }
    if (
      currentTrack &&
      shouldPrefetchNext({
        duration: audio.duration,
        currentTime: audio.currentTime,
        live: isLiveTrack(currentTrack),
      })
    ) {
      prepareNext();
    }
  };

  /**
   * audio.com in un passaggio sincrono (fine brano, «successivo» dalla schermata di blocco, brano
   * che non parte): suona nello stesso evento, senza attese di rete (iOS sospende una pagina
   * bloccata che tace), solo se i dati di /api/music/access non prevedono un blocco (decideAdvance).
   * Il permesso, che registra l'ascolto, parte insieme all'audio: se il server rifiuta (ospite,
   * limite raggiunto nel frattempo) o non conferma, l'audio si ferma con lo stesso invito o
   * messaggio del percorso normale. Le altre fonti non chiedono nulla qui: l'ascolto lo registra la
   * loro route di stream. (audio.com non passa mai dal deck di riserva: preloadsOnSpare.)
   */
  const confirmPermitAlongside = (track: ActiveTrack, src: string) => {
    if (!permitRecordsPlay(track.qualifiedId)) return;
    void requestPlayPermit(track.qualifiedId).then((permit) => {
      // Vale finché il deck attivo ha questo stream (anche in pausa): un altro brano o la chiusura
      // del player nel frattempo l'hanno sostituito o liberato, e la risposta non li riguarda.
      if (decks.current?.getAttribute('src') !== src) return;
      applyPermit(permit, track.qualifiedId);
      if (permit.allowed) return;
      // Annulla l'avvio in corso (i suoi esiti non cambiano più lo stato) e libera l'audio.
      playRequestRef.current += 1;
      releaseAudio();
      setSessionPlaybackState('paused');
      if (permit.unconfirmed) {
        setStatus('error');
        setErrorMessage(PLAY_PERMIT_UNCONFIRMED_MESSAGE);
      } else {
        setStatus('idle');
      }
    });
  };

  /** Same element, same event: new src + play() with no network wait before it. */
  const startSynchronously = (
    index: number,
    next: ActiveTrack,
    audio: HTMLAudioElement,
  ): boolean => {
    // A local file plays from its object URL: without one (not made yet) the normal path reads it.
    const src = deckSource(next, localAudioRef.current);
    if (src === null) return false;
    const request = ++playRequestRef.current;
    try {
      ytPlayerRef.current?.pauseVideo();
    } catch {
      // The IFrame player may still be initialising.
    }
    recordedRef.current = null;
    mediaRetryRef.current = 0;
    retryPositionRef.current = 0;
    reconnectsRef.current = 0;
    pendingSeekRef.current = null;
    // The stream request itself counts the play on the server: refresh the counter once it plays
    // (never for a local file: nothing is counted and nothing is asked of the server). Per
    // audio.com lo conta il permesso inviato qui sotto insieme all'audio.
    refreshOnPlayingRef.current = !isLocalTrack(next);
    restartListeningSample(listeningRef.current);
    declarePlaybackSession();
    audio.src = src;
    audio.load();
    const playing = audio.play();
    confirmPermitAlongside(next, src);
    showNowPlaying(next);
    setSessionPlaybackState('playing');
    setQueueIndex(index);
    setCurrentTrack(next);
    setPreviewEnded(false);
    setPlayBlock(null);
    setErrorMessage(null);
    setStatus('loading');
    setElapsedSeconds(0);
    setDurationSeconds(isLiveTrack(next) ? 0 : (next.durationSeconds ?? 0));
    playing.then(
      () => {
        if (request === playRequestRef.current) setStatus('playing');
      },
      (error: unknown) => {
        if (request !== playRequestRef.current) return;
        // iOS refused a start without a tap (page already suspended), or the system paused the
        // element while it was starting (call, Siri, headphones): wait for the listener, and show
        // the lock screen / notification as paused too (it was set to 'playing' above). Never
        // stuck on 'loading', which disables the play buttons.
        if (startHeldBack(error, audio)) {
          setStatus('paused');
          setSessionPlaybackState('paused');
        }
        // Other failures arrive through the element's 'error' event (handleError).
      },
    );
    return true;
  };

  /**
   * Gapless start: the spare deck already holds the first seconds of `next`. play() on it in the
   * same event, then the roles swap and the old deck is released. If play() is refused, the old
   * deck (unlocked: it was just playing) takes today's synchronous src switch.
   */
  const startOnSpare = (index: number, next: ActiveTrack, spare: HTMLAudioElement) => {
    const old = decks.current;
    if (!old) return;
    const request = ++playRequestRef.current;
    try {
      ytPlayerRef.current?.pauseVideo();
    } catch {
      // The IFrame player may still be initialising.
    }
    recordedRef.current = null;
    mediaRetryRef.current = 0;
    retryPositionRef.current = 0;
    reconnectsRef.current = 0;
    pendingSeekRef.current = null;
    // The continuation of the stream counts the play on the server: refresh the counter once it plays.
    refreshOnPlayingRef.current = !isLocalTrack(next);
    restartListeningSample(listeningRef.current);
    declarePlaybackSession();
    // Only one deck is ever audible: a skip in the middle of a track silences it first.
    old.pause();
    spare.loop = old.loop;
    let playing: Promise<void>;
    try {
      playing = spare.play();
    } catch (error) {
      playing = Promise.reject(error);
    }
    decks.swap();
    decks.spare = null;
    releaseDeck(old);
    showNowPlaying(next);
    setSessionPlaybackState('playing');
    setQueueIndex(index);
    setCurrentTrack(next);
    setPreviewEnded(false);
    setPlayBlock(null);
    setErrorMessage(null);
    setStatus('loading');
    setElapsedSeconds(0);
    setDurationSeconds(next.durationSeconds ?? 0);
    playing.then(
      () => {
        if (request === playRequestRef.current) setStatus('playing');
      },
      (error: unknown) => {
        // A newer request (pause while loading, another item, close) owns the decks now.
        if (request !== playRequestRef.current) return;
        if (isDomError(error, 'AbortError')) {
          // Messo in pausa dal sistema mentre partiva: in pausa, non bloccato su 'loading'.
          if (decks.isActive(spare) && startHeldBack(error, spare)) {
            setStatus('paused');
            setSessionPlaybackState('paused');
          }
          return;
        }
        if (!decks.isActive(spare)) return;
        // Never a silent queue: back to the deck that was playing, with today's src switch.
        decks.swap();
        releaseDeck(spare);
        if (!startSynchronously(index, next, old)) void playQueueIndex(index);
      },
    );
  };

  /**
   * Starts queue item `index` synchronously when that is safe: an audio item whose rights were
   * verified ahead (Audius/Solco) or an open stream (Jamendo, podcast, radio), with no Free-plan
   * block predicted. iOS suspends a locked page soon after its audio stops, so a network wait
   * here would stop the queue until the phone is unlocked. Returns false when the normal path
   * (with its network checks) has to run instead. Un brano di audio.com passa di qui solo con i
   * dati di accesso noti, e il suo permesso parte insieme all'audio (confirmPermitAlongside).
   */
  const advanceTo = (index: number): boolean => {
    const next = queue[index];
    const audio = decks.current;
    if (!next || !audio) return false;
    const prepared = preparedRef.current;
    preparedRef.current = null;
    if (isLocalTrack(next)) {
      // The listener's own file: no access, rights or Free check can block it. Synchronous only
      // with its object URL already made (prepared ~20 s before the end); otherwise the normal
      // path reads it from IndexedDB (and explains a file that is gone).
      const src = deckSource(next, localAudioRef.current);
      if (src === null) return false;
      const spare = decks.spareDeck;
      const wanted: SpareLoad = { index, qualifiedId: next.qualifiedId, src };
      if (spare && spareReadyFor(spare, decks.spare, wanted)) {
        startOnSpare(index, next, spare);
        return true;
      }
      releaseSpare();
      return startSynchronously(index, next, audio);
    }
    const rights =
      prepared && prepared.index === index && prepared.qualifiedId === next.qualifiedId
        ? prepared.rights
        : null;
    const decision = decideAdvance({
      mode: next.playbackMode,
      qualifiedId: next.qualifiedId,
      rights,
      access: accessRef.current,
      replay: isReplay(startedAtRef.current, next.qualifiedId, Date.now()),
    });
    if (decision.kind === 'async') return false;
    if (decision.kind === 'blocked') {
      // The stream would answer 401/402: show the Free-plan message instead of a failed request.
      playRequestRef.current += 1;
      releaseAudio();
      recordedRef.current = null;
      setQueueIndex(index);
      setCurrentTrack(next);
      setErrorMessage(null);
      setPlayBlock(decision.reason);
      setStatus('idle');
      setElapsedSeconds(0);
      return true;
    }
    if (decision.kind === 'denied') {
      // No longer streamable (rights, Pro): skip it, as Apple Music and Spotify do.
      const after = pickNextIndex({
        modes: queue.map((item) => item.playbackMode),
        index,
        shuffle,
        wrap: repeat === 'all',
        hidden: isPageHidden(),
      });
      if (after === null || after === index || after === queueIndex) return false;
      if (!advanceTo(after)) void playQueueIndex(after);
      return true;
    }
    // The spare deck holds exactly this track with data ready: no network wait at all.
    const spare = decks.spareDeck;
    const wanted: SpareLoad = { index, qualifiedId: next.qualifiedId, src: next.streamPath };
    if (spare && spareReadyFor(spare, decks.spare, wanted)) {
      startOnSpare(index, next, spare);
      return true;
    }
    // Not preloaded, another track or not ready: today's src switch on the playing element.
    releaseSpare();
    return startSynchronously(index, next, audio);
  };
  advanceRef.current = advanceTo;

  // Autoplay continuo: a coda finita (senza ripetizione) prosegue da solo con brani consigliati da
  // una fonte lecita (Audius trending). Niente YouTube/terzi. Si ferma da solo quando non ci sono più
  // brani nuovi (dedup per sessione), quindi non cresce all'infinito.
  // false: non è partita (una continuazione per questa stessa richiesta è già in corso).
  const continueAutoplay = (): boolean => {
    // Una sola continuazione per richiesta. È legata a playRequestRef: una rimasta appesa (rete) non
    // blocca quelle delle code successive, perché chiudere o avviare altro fa avanzare la richiesta.
    if (autoplayBusyRef.current === playRequestRef.current) return false;
    // Istantanea della richiesta: se durante il fetch l'utente chiude il player o avvia altro
    // (stopPlayback/un nuovo brano incrementano playRequestRef), la continuazione si annulla e non
    // resuscita la riproduzione.
    const request = playRequestRef.current;
    autoplayBusyRef.current = request;
    setStatus('loading');
    const seen = autoplaySeenRef.current;
    for (const item of queue) seen.add(item.qualifiedId);
    const current = currentTrackRef.current;
    if (current) seen.add(current.qualifiedId);
    void (async () => {
      try {
        const data = await apiFetch('/api/music/trending', {
          schema: MusicTrendingResponseSchema,
          // Una richiesta appesa non lascia il player in 'loading' (pulsanti disattivati).
          signal: AbortSignal.timeout(AUTOPLAY_FETCH_TIMEOUT_MS),
        });
        if (request !== playRequestRef.current) return;
        const picks = selectAutoplayCandidates(data.tracks, seen, AUTOPLAY_BATCH).map(
          audiusResultToTrack,
        );
        const first = picks[0];
        const path = first ? trackStreamPath(first) : null;
        if (!first || !path) {
          releaseAudio();
          setStatus('ended');
          return;
        }
        for (const pick of picks) seen.add(pick.qualifiedId);
        await playTrack(first, path, picks);
      } catch {
        if (request === playRequestRef.current) {
          releaseAudio();
          setStatus('ended');
        }
      } finally {
        if (autoplayBusyRef.current === request) autoplayBusyRef.current = null;
      }
    })();
    return true;
  };

  /**
   * Autoplay continuo con il lotto preparato prima della fine (prepareAutoplay): il primo brano
   * parte nello stesso evento 'ended', senza attese di rete, come un normale passaggio al successivo.
   * false: niente di pronto per questo brano, o un limite/diritto da verificare (percorso di rete).
   */
  const startPreparedAutoplay = (): boolean => {
    const prepared = autoplayNextRef.current;
    autoplayNextRef.current = null;
    const audio = decks.current;
    const current = currentTrack;
    if (!prepared || !audio || !current) return false;
    if (prepared.from !== `${queueIndex}|${current.qualifiedId}`) return false;
    const first = prepared.picks[0];
    if (!first) return false;
    const decision = decideAdvance({
      mode: first.playbackMode,
      qualifiedId: first.qualifiedId,
      rights: prepared.rights,
      access: accessRef.current,
      replay: isReplay(startedAtRef.current, first.qualifiedId, Date.now()),
    });
    if (decision.kind !== 'switch') return false;
    const seen = autoplaySeenRef.current;
    for (const item of queue) seen.add(item.qualifiedId);
    for (const pick of prepared.picks) seen.add(pick.qualifiedId);
    // Una coda nuova, come in playTrack: nulla della coda finita (piani, preparazioni, playlist
    // YouTube, punto di ripresa) passa a questa.
    releaseSpare();
    nextPlanRef.current = null;
    preparedRef.current = null;
    pendingSeekRef.current = null;
    missStreakRef.current = 0;
    ytRunRef.current = null;
    ytAtRef.current = null;
    ytPendingRef.current = null;
    queueRef.current = prepared.picks;
    setQueue(prepared.picks);
    setSessionPlaybackState('playing');
    return startSynchronously(0, first, audio);
  };

  const handleEnded = () => {
    const audio = decks.current;
    if (currentTrack && audio && isLiveTrack(currentTrack)) {
      // Una diretta non «finisce»: il server ha chiuso la connessione (riavvio dell'encoder, mount
      // di riserva, limite di connessioni) e il browser ha suonato il buffer. Si riconnette come
      // dopo un errore, invece di passare a un'altra stazione della coda o fermarsi.
      if (!reconnectLive(currentTrack, audio)) failLive(currentTrack);
      return;
    }
    if (repeat === 'one' && isYouTubeTrack(currentTrack) && ytPlayerRef.current) {
      ytPlayerRef.current.seekTo(0, true);
      ytPlayerRef.current.playVideo();
      return;
    }
    if (repeat === 'one' && audio && currentTrack && !isYouTubeTrack(currentTrack)) {
      // Normally unreachable: with repeat one the element loops and never ends.
      audio.currentTime = 0;
      audio.play().catch(() => undefined);
      return;
    }
    const index = followingIndex(repeat === 'all');
    if (index !== null) {
      // Automatic advance: Now Playing stays "playing" between the two items.
      setSessionPlaybackState('playing');
      if (!advanceTo(index)) void playQueueIndex(index);
      return;
    }
    if (autoplayRef.current) {
      // Coda finita e autoplay acceso: prosegui con brani consigliati, senza fermarti. Il lotto
      // preparato prima della fine parte subito; altrimenti lo si chiede alla rete.
      if (startPreparedAutoplay()) return;
      if (continueAutoplay()) {
        setSessionPlaybackState('playing');
        return;
      }
      // Continuazione già in corso per questa richiesta: il player non resta «in riproduzione»
      // senza audio, finisce come senza autoplay.
    }
    releaseAudio();
    setStatus('ended');
  };

  /** Restart the same stream on the same element, inside the error event (no timer needed). */
  const restartStream = (
    track: ActiveTrack,
    audio: HTMLAudioElement,
    position: number | null,
    src: string = track.streamPath,
  ) => {
    const request = ++playRequestRef.current;
    pendingSeekRef.current =
      position !== null && position > 1
        ? { qualifiedId: track.qualifiedId, seconds: position }
        : null;
    declarePlaybackSession();
    audio.src = src;
    audio.load();
    audio.play().then(
      () => {
        if (request === playRequestRef.current) setStatus('playing');
      },
      (error: unknown) => {
        if (request !== playRequestRef.current) return;
        // iOS refused play() in a suspended page, or the system paused the element while it was
        // restarting: no 'error' event follows, so stop 'loading' (it disables the play buttons)
        // and wait for the listener.
        if (startHeldBack(error, audio)) {
          setStatus('paused');
          setSessionPlaybackState('paused');
        }
        // A network failure arrives as another 'error' event.
      },
    );
  };

  /**
   * Live radio dropped (an error, a connection the server closed, a stream stuck waiting): up to
   * MAX_RECONNECTS in a row. The first one runs right here, on the same element: timers do not fire
   * in a suspended (locked) iOS page. false: no attempts left.
   */
  const reconnectLive = (track: ActiveTrack, audio: HTMLAudioElement): boolean => {
    if (reconnectsRef.current >= MAX_RECONNECTS) return false;
    clearTimer(stallTimerRef);
    const attempt = reconnectsRef.current;
    reconnectsRef.current += 1;
    setStatus('loading');
    if (attempt === 0) {
      restartStream(track, audio, null);
    } else {
      // Closing, pausing or picking another item moves playRequestRef on: the retry is dropped.
      const request = playRequestRef.current;
      clearTimer(reconnectTimerRef);
      reconnectTimerRef.current = window.setTimeout(
        () => {
          reconnectTimerRef.current = null;
          if (request === playRequestRef.current) void playCurrentTrack(track, { reconnect: true });
        },
        1000 * 2 ** (attempt - 1),
      );
    }
    return true;
  };

  /** Diretta che non si riesce a riconnettere: ferma, con il motivo (Play riprova da capo). */
  const failLive = (track: ActiveTrack) => {
    clearTimer(stallTimerRef);
    setStatus('error');
    setErrorMessage(failureMessage(null, track));
    releaseAudio();
  };

  /**
   * Il punto da cui riprendere `track` dopo un'interruzione (vedi pendingSeekRef). Un elemento appena
   * ripartito da 0 (ritentativo) tiene il punto già noto per lo stesso brano; la diretta non ne ha.
   */
  const rememberResumePoint = (track: ActiveTrack, position: number) => {
    if (isLiveTrack(track)) {
      pendingSeekRef.current = null;
      return;
    }
    if (Number.isFinite(position) && position > 1) {
      pendingSeekRef.current = { qualifiedId: track.qualifiedId, seconds: position };
    } else if (pendingSeekRef.current?.qualifiedId !== track.qualifiedId) {
      pendingSeekRef.current = null;
    }
  };

  /**
   * A stream failed: GET /api/music/access (never consumes a play) tells if the Free limit is why.
   * `onNoBlock`: what to do when the limit is not the reason (e.g. skip an item that never started).
   */
  const explainStreamFailure = (track: ActiveTrack, onNoBlock?: () => void) => {
    const request = playRequestRef.current;
    const replay = isReplay(startedAtRef.current, track.qualifiedId, Date.now());
    void loadAccess().then((access) => {
      if (request !== playRequestRef.current) return;
      const block = predictPlayBlock(access, { qualifiedId: track.qualifiedId, replay });
      if (!block) {
        onNoBlock?.();
        return;
      }
      setErrorMessage(null);
      setPlayBlock(block);
      setStatus('idle');
    });
  };

  /**
   * A local file failed in the element: read it again from IndexedDB with a fresh object URL. Gone
   * (removed or evicted): say so and skip it. Still there: once, resume where it stopped (as for a
   * stream drop); otherwise the browser cannot decode it, so skip it. Nothing reaches the server.
   */
  const handleLocalError = (track: ActiveTrack, audio: HTMLAudioElement) => {
    const failedAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const request = ++playRequestRef.current;
    releaseAudio();
    localAudioRef.current.get(track.qualifiedId)?.revoke();
    localAudioRef.current.delete(track.qualifiedId);
    setStatus('loading');
    void loadLocalSource(track).then((source) => {
      if (request !== playRequestRef.current) return;
      if (source.ok && failedAt > 0 && mediaRetryRef.current < MAX_MEDIA_RETRIES) {
        mediaRetryRef.current += 1;
        retryPositionRef.current = failedAt;
        restartStream(track, audio, failedAt, source.url);
        return;
      }
      const message = source.ok
        ? LOCAL_UNPLAYABLE_MESSAGE
        : source.reason === 'missing'
          ? LOCAL_MISSING_MESSAGE
          : LOCAL_UNAVAILABLE_MESSAGE;
      setStatus('error');
      setErrorMessage(message);
      setLocalSkip({ qualifiedId: track.qualifiedId, request, message });
    });
  };

  const handleError = () => {
    const audio = decks.current;
    if (!currentTrack || !audio) return;
    if (previewEnded) return;
    // An error of a released element (no source) belongs to a playback already stopped.
    if (!audio.getAttribute('src')) return;
    const track = currentTrack;
    clearTimer(stallTimerRef);
    // Play premuto dopo una pausa e play() non ancora partito: l'errore segue le regole di chi suona
    // (ritentativo dal punto o messaggio), altrimenti la richiesta andrebbe persa in silenzio.
    const resumeRequested = resumeRequestRef.current === playRequestRef.current;
    resumeRequestRef.current = null;
    if (status === 'paused' && !resumeRequested) {
      // In pausa (dall'ascoltatore o dal sistema): un errore (rete cambiata, connessione chiusa dal
      // server) non deve far ripartire l'audio da solo. Si libera la sorgente e si ricorda il punto:
      // il prossimo Play riparte da lì (playCurrentTrack; una diretta si riconnette da capo).
      rememberResumePoint(track, audio.currentTime);
      clearTimer(reconnectTimerRef);
      releaseAudio();
      if (isLocalTrack(track)) {
        // L'object URL che ha fallito non si riusa: il prossimo Play rilegge il file da IndexedDB.
        localAudioRef.current.get(track.qualifiedId)?.revoke();
        localAudioRef.current.delete(track.qualifiedId);
      }
      return;
    }
    if (isLocalTrack(track)) {
      handleLocalError(track, audio);
      return;
    }
    // Live radio drops on network changes (Wi-Fi ↔ mobile): reconnect (see reconnectLive).
    if (isLiveTrack(track) && reconnectLive(track, audio)) return;
    if (!isLiveTrack(track) && isOffline()) {
      // Senza rete il ritentativo fallirebbe subito (e il messaggio darebbe la colpa alla fonte):
      // si ricorda il punto e si riprende da soli quando torna la connessione (evento 'online').
      rememberResumePoint(track, audio.currentTime);
      offlineResumeRef.current = track.qualifiedId;
      releaseAudio();
      setStatus('error');
      setErrorMessage(OFFLINE_RESUME_MESSAGE);
      return;
    }
    if (
      !isLiveTrack(track) &&
      !isYouTubeTrack(track) &&
      audio.currentTime > 0 &&
      mediaRetryRef.current < MAX_MEDIA_RETRIES
    ) {
      // A drop in the middle of a track or an episode: resume where it stopped, like native
      // players. Within the replay window the stream route does not count this request again.
      mediaRetryRef.current += 1;
      retryPositionRef.current = audio.currentTime;
      setStatus('loading');
      restartStream(track, audio, audio.currentTime);
      return;
    }
    // Non è partito affatto (rifiutato al primo byte, file sparito dopo un aggiornamento del
    // catalogo, nodo Audius in errore) e non è un ritentativo fallito: escluso il limite Free, si
    // passa al successivo come per video e file locali, invece di fermare tutta la coda. Una ripresa
    // con un punto salvato per questo elemento (coda ripristinata, errore in pausa, ritorno della
    // rete) era già partita: non si salta, e il prossimo Play riprende da quel punto.
    const neverStarted =
      !isLiveTrack(track) &&
      !isYouTubeTrack(track) &&
      audio.currentTime === 0 &&
      mediaRetryRef.current === 0 &&
      pendingSeekRef.current?.qualifiedId !== track.qualifiedId;
    // Caduta a metà brano (non «mai partito»): dopo il ritentativo in corso il brano resterebbe fermo.
    // Ricorda il punto e, se non è il limite Free, riparti da solo quando il brano torna in primo piano
    // (resumeOnReturn) o torna la rete (evento 'online'). Vale anche per i brani in evidenza.
    if (!neverStarted) {
      const droppedAt = retryPositionRef.current > 0 ? retryPositionRef.current : audio.currentTime;
      rememberResumePoint(track, droppedAt);
      dropResumeRef.current = track.qualifiedId;
    }
    setStatus('error');
    setErrorMessage(
      isOpenStream(track)
        ? failureMessage(null, track)
        : track.playbackMode === 'jamendo'
          ? 'Lo stream Jamendo si è interrotto. Riprova.'
          : 'Lo stream Audius è terminato con un errore. L’audio è stato fermato.',
    );
    releaseAudio();
    explainStreamFailure(
      track,
      neverStarted ? () => skipUnavailableRef.current(track.qualifiedId) : undefined,
    );
  };

  /**
   * Diretta che aspetta dati ('waiting'/'stalled') senza un 'error': connessione appesa (encoder
   * bloccato, cambio di rete senza reset). Se dopo LIVE_STALL_MS il tempo non è avanzato si
   * riconnette come dopo un errore. Annullato da 'playing', pausa, errore, chiusura o altro avvio.
   */
  const watchLiveStall = () => {
    const audio = decks.current;
    // Anche brani ed episodi: un cambio di rete può appendere la connessione senza un 'error'.
    if (!currentTrack || !audio || isYouTubeTrack(currentTrack) || stallTimerRef.current !== null) {
      return;
    }
    const request = playRequestRef.current;
    const position = audio.currentTime;
    stallTimerRef.current = window.setTimeout(() => {
      stallTimerRef.current = null;
      stallRecoveryRef.current(request, position);
    }, LIVE_STALL_MS);
  };
  stallRecoveryRef.current = (request, position) => {
    const audio = decks.current;
    const track = currentTrack;
    if (request !== playRequestRef.current || !track || !audio || isYouTubeTrack(track)) return;
    if (status !== 'playing' && status !== 'loading') return;
    // Avanzato nel frattempo (un 'stalled' mentre suonava il buffer): nessun blocco.
    if (!audio.getAttribute('src') || audio.currentTime > position + 1) return;
    if (isLiveTrack(track)) {
      if (!reconnectLive(track, audio)) failLive(track);
      return;
    }
    // Brano o episodio fermo a metà: riapre lo stream dallo stesso punto (stesso limite di
    // ritentativi di un errore di rete). Un file del dispositivo non si blocca per la rete.
    if (isLocalTrack(track) || audio.currentTime <= 0) return;
    if (mediaRetryRef.current >= MAX_MEDIA_RETRIES) return;
    mediaRetryRef.current += 1;
    retryPositionRef.current = audio.currentTime;
    setStatus('loading');
    restartStream(track, audio, audio.currentTime);
  };

  /** Keeps the system scrubber in step with the element (the OS extrapolates between updates). */
  const syncPositionState = () => {
    const session = mediaSessionOrNull();
    const audio = decks.current;
    if (!session || !audio) return;
    applyPositionState(
      session,
      isYouTubeTrack(currentTrack)
        ? null
        : mediaPositionState({
            duration: audio.duration,
            currentTime: audio.currentTime,
            playbackRate: audio.playbackRate,
            live: isLiveTrack(currentTrack),
          }),
    );
    // Reported WebKit quirk: re-assert the playback state after a position update.
    if (audio.getAttribute('src') && !audio.ended) {
      setSessionPlaybackState(audio.paused ? 'paused' : 'playing');
    }
  };
  // Latest closure for the Now Playing effect (set every render).
  const syncPositionStateRef = useRef(syncPositionState);
  syncPositionStateRef.current = syncPositionState;

  // System controls (lock screen, Control Center, Android notification, headset): which actions
  // exist depends on the kind of item (see media-session.ts). Handlers read the latest state.
  const sessionPlanRef = useRef<ActionPlan | null>(null);
  sessionPlanRef.current = currentTrack
    ? mediaSessionActionPlan({
        kind: mediaSessionKind(currentTrack.playbackMode),
        hasNext,
        hasPrevious: queueIndex > 0,
      })
    : null;
  const systemActionRef = useRef<
    (action: SessionAction, details: MediaSessionActionDetails) => void
  >(() => undefined);
  systemActionRef.current = (action, details) => {
    switch (action) {
      case 'play':
        void resumePlayback();
        return;
      case 'pause':
        pausePlayback();
        return;
      case 'stop':
        stopPlayback();
        return;
      case 'previoustrack':
        void previousTrack();
        return;
      case 'nexttrack':
        void nextTrack();
        return;
      default: {
        const audio = decks.current;
        if (!audio || !currentTrack || isLiveTrack(currentTrack) || isYouTubeTrack(currentTrack)) {
          return;
        }
        const target = seekTargetSeconds(action, details, {
          currentTime: audio.currentTime,
          duration: audio.duration,
        });
        if (target === null) return;
        seekMediaElement(audio, target, details.fastSeek === true);
        setElapsedSeconds(target);
      }
    }
  };
  const registerSystemControls = useCallback(() => {
    const session = mediaSessionOrNull();
    if (!session) return;
    const plan = sessionPlanRef.current;
    for (const action of MEDIA_SESSION_ACTIONS) {
      // Explicit null for the actions this kind of item does not offer: on iOS a seek handler
      // would replace previous/next on the lock screen.
      const handler: MediaSessionActionHandler | null = plan?.[action]
        ? (details) => systemActionRef.current(action, details)
        : null;
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Browsers expose different supported Media Session actions.
      }
    }
  }, []);

  const handlePlaying = () => {
    // Il deck attivo (anche dopo uno scambio gapless) riprende la velocità scelta; la diretta radio
    // resta a 1× (vedi l'effetto sulla velocità).
    applyElementSpeed(
      decks.current,
      isLiveTrack(currentTrackRef.current) ? 1 : playbackSpeedRef.current,
    );
    setStatus('playing');
    setBuffering(false);
    clearTimer(stallTimerRef);
    setSessionPlaybackState('playing');
    syncPositionState();
    // WebKit drops handlers registered before the page became "Now Playing": set them again.
    registerSystemControls();
    // An item plays: the "missing in a row" count starts again (see skipLocal / skipMissing).
    missStreakRef.current = 0;
    if (currentTrack && !isLocalTrack(currentTrack)) {
      // The stream delivered audio, so the server allowed (and counted) it: replay window starts.
      rememberStart(startedAtRef.current, currentTrack.qualifiedId, Date.now());
    }
    if (refreshOnPlayingRef.current) {
      refreshOnPlayingRef.current = false;
      void loadAccess();
    }
  };

  const handleDurationChange = () => {
    handleTimeUpdate();
    syncPositionState();
  };

  const handleLoadedMetadata = () => {
    const audio = decks.current;
    // load() riporta playbackRate a defaultPlaybackRate: riapplica la velocità sulla nuova sorgente
    // (la diretta radio resta a 1×).
    applyElementSpeed(audio, isLiveTrack(currentTrackRef.current) ? 1 : playbackSpeedRef.current);
    const pending = pendingSeekRef.current;
    if (audio && pending !== null) {
      // Solo l'elemento a cui appartiene riprende da quel punto; per qualunque altro si scarta.
      if (currentTrackRef.current?.qualifiedId !== pending.qualifiedId) {
        pendingSeekRef.current = null;
      } else if (Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(pending.seconds, audio.duration);
        pendingSeekRef.current = null;
      }
    }
    handleTimeUpdate();
    syncPositionState();
  };

  /** Media events drive the player only from the active deck: the spare is silent, preloading. */
  const onActiveDeck = (handler: () => void) => (event: SyntheticEvent<HTMLAudioElement>) => {
    if (decks.isActive(event.currentTarget)) handler();
  };

  const handleDeckError = (event: SyntheticEvent<HTMLAudioElement>) => {
    const deck = event.currentTarget;
    if (decks.isActive(deck)) {
      handleError();
      return;
    }
    // The preload failed (rights, quota, network): released quietly, the advance takes today's
    // path and its own error handling.
    const held = decks.spare;
    if (held && deck === decks.spareDeck && deck.getAttribute('src') === held.src) releaseSpare();
  };

  const handlePause = () => {
    const audio = decks.current;
    restartListeningSample(listeningRef.current);
    setBuffering(false);
    clearTimer(stallTimerRef);
    // Una pausa (anche di sistema) annulla la ripresa chiesta prima (vedi resumeRequestRef).
    resumeRequestRef.current = null;
    // The 'pause' fired at the end of an item: 'ended' moves on, Now Playing stays "playing".
    if (!audio || audio.ended) return;
    // Also follows pauses decided by the system: calls, Siri, headphones unplugged.
    setStatus((current) => (current === 'playing' ? 'paused' : current));
    if (audio.getAttribute('src')) syncPositionState();
    // Il punto esatto della pausa (il salvataggio periodico va solo ogni 5 s).
    saveQueueRef.current();
  };

  const hidePlayer = pathname === '/admin' || pathname.startsWith('/admin/');
  const showFull = expanded && Boolean(currentTrack) && !hidePlayer;
  // Keep the YouTube dock (and its player) mounted while an imported song is being looked up, so
  // the player is reused instead of being rebuilt for every song (a found song becomes a YouTube
  // track). Once the search failed, or after a page load before play, there is no video: no dock.
  const youtubeActive =
    !hidePlayer &&
    (isYouTubeTrack(currentTrack) ||
      (currentTrack?.playbackMode === 'song' && status === 'loading'));
  // "Ascolta altrove": the same song on Spotify, YouTube Music, SoundCloud, Deezer and TIDAL as
  // plain search links (no API of those services and no embedded player involved). Never for the
  // listener's own file: its tags (or file name) must not leave the device, not even in a link.
  const songSearch = (() => {
    if (
      !currentTrack ||
      isLiveTrack(currentTrack) ||
      currentTrack.playbackMode === 'podcast' ||
      isLocalTrack(currentTrack)
    ) {
      return null;
    }
    const song =
      isYouTubeTrack(currentTrack) && !currentTrack.importedFrom
        ? parseVideoTitle(currentTrack.title, currentTrack.artistName)
        : { title: currentTrack.title, artist: currentTrack.artistName };
    const title = song.title.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim();
    return title ? { title, artist: song.artist || null } : null;
  })();
  // "Condividi": brano (artista e titolo) o radio in diretta, con un link alla ricerca di Solco sul
  // sito pubblico. Mai per i file dell'utente (privati) né per i podcast.
  // Per un brano Audius il link porta il suo id: la scheda delle anteprime social (copertina,
  // titolo, artista) la legge il server da Audius, mai da un URL nel link. imageUrl è la stessa
  // scheda che la pagina mette in og:image per quel link; va allegata nel menu del telefono.
  const shareTarget = (() => {
    if (songSearch) {
      const audiusId = audiusTrackIdFromQualifiedId(currentTrack?.qualifiedId);
      const url = songShareUrl(songSearch.title, songSearch.artist, undefined, audiusId);
      return {
        title: songSearch.title,
        text: songShareText(songSearch.title, songSearch.artist),
        url,
        imageUrl: songShareImagePath(url),
      };
    }
    if (currentTrack && isLiveTrack(currentTrack) && !isLocalTrack(currentTrack)) {
      const url = songShareUrl(currentTrack.title, null);
      return {
        title: currentTrack.title,
        text: songShareText(currentTrack.title, null, true),
        url,
        imageUrl: songShareImagePath(url),
      };
    }
    return null;
  })();
  // "Sfida un amico": il quiz del brano (/quiz), solo con titolo e artista. Il link porta la
  // risposta codificata (mai leggibile nel testo, nel link o nell'anteprima); per un brano Audius
  // anche il suo id, come "Condividi": la scheda la disegna il server leggendo il brano da Audius.
  // Per un video YouTube solo se il titolo è «Artista - Titolo»: altrimenti l'artista di songSearch
  // è il canale (un'etichetta, chi ha caricato il video), una risposta sbagliata o già scritta nel
  // titolo. Stessa regola del mazzo dei tuoi ascolti (historyDeck).
  const quizTarget = (() => {
    if (!songSearch?.artist || !currentTrack) return null;
    if (
      isYouTubeTrack(currentTrack) &&
      !currentTrack.importedFrom &&
      !videoTitleSong(currentTrack.title)
    ) {
      return null;
    }
    return songQuizShare({
      title: songSearch.title,
      artist: songSearch.artist,
      audiusId: audiusTrackIdFromQualifiedId(currentTrack.qualifiedId),
    });
  })();
  // The YouTube Music link opens the same video when the track is a YouTube video.
  const songSearchVideoId = currentTrack?.qualifiedId.startsWith('youtube:')
    ? currentTrack.qualifiedId.slice('youtube:'.length)
    : null;

  const recordProgress = (track: MusicPlayerTrack, seconds: number) => {
    if (recordedRef.current !== track.qualifiedId && seconds >= HISTORY_THRESHOLD_SECONDS) {
      recordedRef.current = track.qualifiedId;
      recordPlay(track);
    }
  };

  // Latest handlers for the YouTube engine callbacks (created once per player instance).
  skipMissingRef.current = () => {
    missStreakRef.current += 1;
    if (missStreakRef.current >= Math.max(1, queue.length)) return;
    const index = followingIndex(repeat === 'all');
    if (index !== null && index !== queueIndex) void playQueueIndex(index);
  };
  // An on-demand item that never started (see handleError), once the Free limit is ruled out: the
  // next item starts and the message stays while it plays. Stops after a full lap, or after
  // MAX_START_FAILURE_SKIPS in a row (then the cause is not the item).
  skipUnavailableRef.current = (qualifiedId) => {
    if (currentTrack?.qualifiedId !== qualifiedId) return;
    missStreakRef.current += 1;
    if (missStreakRef.current >= Math.max(1, Math.min(queue.length, MAX_START_FAILURE_SKIPS))) {
      return;
    }
    const index = followingIndex(repeat === 'all');
    if (index === null || index === queueIndex) return;
    if (!advanceRef.current(index)) void playQueueIndex(index);
    // The next item clears the message as it starts: keep it (a notice that item set wins).
    setErrorMessage((current) => current ?? UNAVAILABLE_SKIP_MESSAGE);
  };
  // A local item whose file is gone or cannot be decoded (see localSkip): the next item starts and
  // the message stays while it plays. Like imported songs, the skipping stops after a full lap.
  const skipLocalRef = useRef<
    (skip: { qualifiedId: string; request: number; message: string }) => void
  >(() => undefined);
  skipLocalRef.current = (skip) => {
    // The listener chose something else (or closed the player) meanwhile.
    if (skip.request !== playRequestRef.current || currentTrack?.qualifiedId !== skip.qualifiedId) {
      return;
    }
    missStreakRef.current += 1;
    if (missStreakRef.current >= Math.max(1, queue.length)) return;
    const index = followingIndex(repeat === 'all');
    if (index === null || index === queueIndex) return;
    void playQueueIndex(index);
    // The next item clears the message as it starts: keep it (a notice that item set wins).
    setErrorMessage((current) => current ?? skip.message);
  };
  // Video found hidden: never audible in the background (YouTube API terms), whatever started it.
  const deferHiddenVideo = (qualifiedId: string) => {
    deferredVideoRef.current = qualifiedId;
    setStatus('paused');
    setErrorMessage(YOUTUBE_HIDDEN_NOTICE);
    setSessionPlaybackState('paused');
  };
  // Playlist runs follow the queue order: off with shuffle (random next) and repeat one.
  const youtubeRunsEnabled = !shuffle && repeat !== 'one';

  /**
   * Sends the official player to queue item `index` (video `videoId`): a jump inside the playlist
   * it already holds (playVideoAt), otherwise the item's run as a new playlist (loadPlaylist: YouTube
   * then prepares and starts the following videos itself) or the single video (loadVideoById).
   * Only while Solco is visible: every one of these starts the video.
   */
  const loadYouTubeItem = (
    player: YouTubeEngine,
    index: number,
    videoId: string,
    startSeconds = 0,
  ) => {
    const items = queueRef.current;
    const loaded = ytRunRef.current;
    const from = ytAtRef.current?.index ?? null;
    try {
      if (runHoldsIndex(loaded, items, index) && typeof player.playVideoAt === 'function') {
        player.playVideoAt(index - loaded.start);
      } else {
        const run = youtubeRunsEnabled ? youtubeRunAt(items, index) : null;
        if (run && run.videoIds.length > 1 && typeof player.loadPlaylist === 'function') {
          player.loadPlaylist(run.videoIds, run.offset, startSeconds);
          ytRunRef.current = run;
        } else {
          player.loadVideoById(videoId);
          ytRunRef.current = null;
        }
      }
    } catch {
      // The official player is still starting: its onReady loads the current item.
      return;
    }
    ytAtRef.current = { index, videoId, request: playRequestRef.current };
    ytPendingRef.current = ytRunRef.current ? { index, from } : null;
  };

  /**
   * The official player moved along its playlist by itself (end of a video): the app follows to that
   * item without reloading anything, so title, lock-screen metadata, history and the return notice
   * belong to the video on screen. Returns the item followed, or null (no move, or a report from
   * before the app's own move, whose command is about to land).
   */
  const followYouTube = (): { index: number; track: ActiveTrack } | null => {
    const player = ytPlayerRef.current;
    const run = ytRunRef.current;
    const items = queueRef.current;
    const appIndex = queueIndexRef.current;
    // The app is not on the playlist any more (another item was chosen): nothing to follow.
    if (!player || !runHoldsIndex(run, items, appIndex)) return null;
    const position = reportedRunPosition(run, readPlayerReport(player), appIndex - run.start);
    if (position === null) {
      // An unknown report never blocks the end of the item (see onEnded).
      ytPendingRef.current = null;
      return null;
    }
    const index = run.start + position;
    if (predatesMove(ytPendingRef.current, index)) return null;
    ytPendingRef.current = null;
    const track = items[index];
    if (index === appIndex || !track) return null;
    queueIndexRef.current = index;
    currentTrackRef.current = track;
    ytAtRef.current = {
      index,
      videoId: run.videoIds[position] ?? '',
      request: playRequestRef.current,
    };
    deferredVideoRef.current = null;
    recordedRef.current = null;
    setQueueIndex(index);
    setCurrentTrack(track);
    setPlayBlock(null);
    setErrorMessage(null);
    setElapsedSeconds(0);
    setDurationSeconds(track.durationSeconds ?? 0);
    return { index, track };
  };

  /**
   * Next / previous / a queue tap onto another video of the playlist loaded in the official player:
   * nextVideo(), previousVideo() or playVideoAt(), no reload. False when the normal path has to run
   * (no playlist, an item outside it, or Solco hidden: a video never starts in the background).
   */
  moveInRunRef.current = (index: number) => {
    const player = ytPlayerRef.current;
    const run = ytRunRef.current;
    const items = queueRef.current;
    const target = items[index];
    if (!player || !target || isPageHidden() || !runHoldsIndex(run, items, index)) return false;
    if (typeof player.playVideoAt !== 'function') return false;
    const position = index - run.start;
    const appIndex = queueIndexRef.current;
    const from =
      reportedRunPosition(run, readPlayerReport(player), appIndex - run.start) ??
      (runHoldsIndex(run, items, appIndex) ? appIndex - run.start : null);
    const move = runMoveCommand(from, position);
    try {
      if (move.kind === 'next' && player.nextVideo) player.nextVideo();
      else if (move.kind === 'previous' && player.previousVideo) player.previousVideo();
      else player.playVideoAt(position);
    } catch {
      return false;
    }
    // Cancels a lookup or permit still pending for the item we leave.
    const request = ++playRequestRef.current;
    ytPendingRef.current = { index, from: from === null ? null : run.start + from };
    ytAtRef.current = { index, videoId: run.videoIds[position] ?? '', request };
    // Not played yet: hiding Solco before it starts is no "video fermato".
    ytPlayingRef.current = false;
    deferredVideoRef.current = null;
    recordedRef.current = null;
    queueIndexRef.current = index;
    currentTrackRef.current = target;
    setQueueIndex(index);
    setCurrentTrack(target);
    setPlayBlock(null);
    setErrorMessage(null);
    setStatus('loading');
    setElapsedSeconds(0);
    setDurationSeconds(target.durationSeconds ?? 0);
    return true;
  };

  /** A video started (or is about to) while Solco is hidden: paused at once, explained on return. */
  const pauseHiddenVideo = (track: ActiveTrack | null) => {
    try {
      ytPlayerRef.current?.pauseVideo();
    } catch {
      // Player not ready.
    }
    // It was playing (or starting) and stopped only because Solco is hidden: explain it on return.
    ytPlayingRef.current = false;
    markHiddenPause(track ? youtubeVideoId(track) : null);
    setStatus('paused');
    setSessionPlaybackState('paused');
  };

  ytEvents.current = {
    onReady: () => {
      // Created with the current video: hand YouTube its run, so the next videos are prepared (or
      // load the item the app moved to while the player was starting). Never while hidden.
      const player = ytPlayerRef.current;
      applyYouTubeRate(player);
      const track = currentTrackRef.current;
      const index = queueIndexRef.current;
      const videoId = track && isYouTubeTrack(track) ? youtubeVideoId(track) : null;
      if (!player || !track || !videoId || ytRunRef.current || isPageHidden()) return;
      if (deferredVideoRef.current === track.qualifiedId) return;
      const at = ytAtRef.current;
      if (at?.index === index && at.videoId === videoId) {
        if (playBlock !== null || status === 'paused') {
          // Creato con autoplay, ma intanto l'avvio è stato rifiutato (accesso richiesto) o messo
          // in pausa: il video resta fermo invece di partire da solo.
          try {
            player.pauseVideo();
          } catch {
            // Player not ready.
          }
          return;
        }
        const run = youtubeRunsEnabled ? youtubeRunAt(queueRef.current, index) : null;
        if (!run || run.videoIds.length < 2 || typeof player.loadPlaylist !== 'function') return;
        let position = 0;
        try {
          position = Math.max(0, player.getCurrentTime() || 0);
        } catch {
          // Not started yet: from the beginning.
        }
        loadYouTubeItem(player, index, videoId, position);
        return;
      }
      if (playBlock === null) loadYouTubeItem(player, index, videoId);
    },
    onPlaying: () => {
      applyYouTubeRate(ytPlayerRef.current);
      const followed = followYouTube();
      if (isPageHidden()) {
        // Also a video YouTube advanced to on its own: never audible in the background. The ref,
        // not the render-time track: an earlier report this turn may have followed already.
        pauseHiddenVideo(followed?.track ?? currentTrackRef.current);
        return;
      }
      // The video plays again (player controls or the notice): the notice has done its job.
      dismissReturnNotice();
      // Something in the queue plays: the "missing in a row" count starts again.
      missStreakRef.current = 0;
      setStatus('playing');
      setErrorMessage(null);
      setSessionPlaybackState('playing');
    },
    onPaused: () => {
      // A late pause of the video we left for an audio item must not pause that item.
      if (currentTrack && !isYouTubeTrack(currentTrack) && currentTrack.playbackMode !== 'song') {
        return;
      }
      setStatus((value) => (value === 'playing' || value === 'loading' ? 'paused' : value));
      setSessionPlaybackState('paused');
    },
    onEnded: () => {
      const run = ytRunRef.current;
      const index = queueIndexRef.current;
      if (runHoldsIndex(run, queueRef.current, index)) {
        // The video left by a move the listener asked for (next, a queue tap): not this item's end.
        if (ytPendingRef.current) return;
        if (continuesInRun(run, index) && !playerListsRun(ytPlayerRef.current, run)) {
          // YouTube's playlist is not this run (any more): it will not start the next video by
          // itself, so the queue goes on as for a single video (a new run is loaded from there).
          ytRunRef.current = null;
          ytPendingRef.current = null;
        } else if (continuesInRun(run, index)) {
          if (repeat === 'one') {
            // YouTube would go on to the next video of its playlist: back to this one instead.
            if (!isPageHidden()) {
              try {
                ytPlayerRef.current?.playVideoAt?.(index - run.start);
                ytPendingRef.current = { index, from: index };
              } catch {
                // Player not ready.
              }
            }
            return;
          }
          if (!shuffle) {
            // YouTube starts the next video of the run by itself; the app follows it on PLAYING.
            setStatus('loading');
            return;
          }
          // Shuffle: the app picks the next item; YouTube's own next video is not followed.
          ytPendingRef.current = { index: -1, from: index };
        }
      }
      // Last video of the run (or a single video): the queue goes on (Audius, podcast, …).
      handleEnded();
    },
    onBuffering: () => {
      // Hidden: whatever video is loading is paused before it is ever heard (one YouTube advances
      // to on its own, or a move sent just before Solco was hidden whose pause got lost).
      if (isPageHidden()) {
        // Buffering keeps the engine flag: true only for a video that was playing.
        const wasPlaying = ytPlayingRef.current;
        const followed = followYouTube();
        if (followed || wasPlaying) {
          pauseHiddenVideo(followed?.track ?? currentTrackRef.current);
          return;
        }
        // Never played: paused, with no "video fermato" notice.
        try {
          ytPlayerRef.current?.pauseVideo();
        } catch {
          // Player not ready.
        }
        setStatus('paused');
        setSessionPlaybackState('paused');
        return;
      }
      setStatus('loading');
    },
    onCued: () => {
      followYouTube();
      // Cued, not started (autoplay refused, or an embed that cues the next playlist video): the
      // current video waits for play, so the play buttons must not stay disabled on 'loading'.
      const player = ytPlayerRef.current;
      const track = currentTrackRef.current;
      const videoId = track && isYouTubeTrack(track) ? youtubeVideoId(track) : null;
      if (!player || !videoId) return;
      const reported = readPlayerReport(player).videoId;
      if (typeof reported === 'string' && reported !== videoId) return;
      setStatus((value) => (value === 'loading' || value === 'playing' ? 'paused' : value));
      setSessionPlaybackState('paused');
    },
    onError: (code) => {
      // The failing video may be one YouTube moved to by itself inside its playlist.
      const followed = followYouTube();
      const failed = followed?.track ?? currentTrackRef.current;
      const failedIndex = followed?.index ?? queueIndexRef.current;
      // A video chosen for an imported song does not play: forget that choice for everyone.
      const failedVideo = failed ? youtubeVideoId(failed) : null;
      if (failed?.importedFrom && failedVideo) {
        void fetch('/api/music/resolve-song', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: failed.title,
            artist: failed.artistName || undefined,
            videoId: failedVideo,
          }),
        }).catch(() => undefined);
      }
      // Video che non partono di fila: dopo un giro completo della coda ci si ferma, come per i
      // brani importati non trovati, invece di saltare all'infinito con «Ripeti tutta la coda» o in
      // casuale (caricamenti, richieste e batteria senza fine). onPlaying azzera il conteggio.
      missStreakRef.current += 1;
      const lapDone = missStreakRef.current >= Math.max(1, queue.length);
      const index = lapDone ? null : followingIndex(repeat === 'all', failedIndex);
      const moving = index !== null && index !== failedIndex;
      // 101/150: the uploader blocked embedding; 100: removed; 2/5: invalid or HTML5 error.
      const reason =
        code === 101 || code === 150
          ? 'Questo video non può essere riprodotto fuori da YouTube.'
          : 'Il video non è disponibile.';
      setErrorMessage(
        moving
          ? `${reason} Passo al successivo.`
          : lapDone && queue.length > 1
            ? YOUTUBE_QUEUE_UNPLAYABLE_MESSAGE
            : reason,
      );
      if (moving && index !== null) void playQueueIndex(index);
      else setStatus('error');
    },
    onProgress: (elapsed, duration) => {
      // A poll tick that lands after the app moved to an audio or local item (the interval stops
      // only once effects run): it is the old video's position, not this item's.
      if (
        !currentTrack ||
        (!isYouTubeTrack(currentTrack) && currentTrack.playbackMode !== 'song')
      ) {
        return;
      }
      setElapsedSeconds(elapsed);
      // Una diretta YouTube riporta una durata che cresce a ogni tick: niente render per scarti < 1 s.
      if (duration > 0) {
        setDurationSeconds((previous) => (Math.abs(previous - duration) < 1 ? previous : duration));
      }
      recordProgress(currentTrack, elapsed);
    },
  };

  // YouTube engine: create the official player inside the visible dock, then reuse it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ytRequest is an explicit (re)load trigger.
  useEffect(() => {
    if (!youtubeActive || !currentTrack) return;
    const videoId = youtubeVideoId(currentTrack);
    const host = ytHostRef.current;
    if (!videoId || !host) return;
    const explicit = ytRequest !== ytRequestSeenRef.current;
    ytRequestSeenRef.current = ytRequest;
    const index = queueIndexRef.current;
    const at = ytAtRef.current;
    // The player is already on this item: YouTube moved along its playlist (followed), an in-run
    // move was sent, or this same play request loaded it before its permit came back. No reload.
    if (
      ytPlayerRef.current &&
      at?.index === index &&
      at.videoId === videoId &&
      (!explicit || at.request === playRequestRef.current)
    ) {
      return;
    }
    // A new video has not played yet: a hide before it starts is not a "video fermato".
    ytPlayingRef.current = false;
    // Loading a video starts it: never in a hidden page. It starts when Solco is visible again.
    if (isPageHidden()) {
      deferHiddenVideo(currentTrack.qualifiedId);
      return;
    }
    if (ytPlayerRef.current) {
      // Its playlist run (YouTube prepares the next videos), a jump inside it, or the single video.
      loadYouTubeItem(ytPlayerRef.current, index, videoId);
      return;
    }
    let cancelled = false;
    const qualifiedId = currentTrack.qualifiedId;
    // Avvio a cui appartiene la creazione: se nel frattempo è stato rifiutato (accesso richiesto),
    // messo in pausa o sostituito, il player non si crea (con autoplay partirebbe da solo).
    const request = playRequestRef.current;
    loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled || !ytHostRef.current || request !== playRequestRef.current) return;
        if (isPageHidden()) {
          deferHiddenVideo(qualifiedId);
          return;
        }
        const mount = document.createElement('div');
        ytHostRef.current.replaceChildren(mount);
        const Player = api.Player as unknown as new (
          element: HTMLElement,
          options: Record<string, unknown>,
        ) => YouTubeEngine;
        ytPlayerRef.current = new Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          host: 'https://www.youtube.com',
          playerVars: {
            autoplay: 1,
            controls: 0,
            playsinline: 1,
            rel: 0,
            disablekb: 1,
            iv_load_policy: 3,
            origin: window.location.origin,
          },
          events: {
            onReady: () => ytEvents.current.onReady(),
            onStateChange: (event: { data: number }) => {
              // Paused, ended, unstarted (new video) or cued: not playing. Buffering keeps the
              // previous value: a re-buffer mid-song (or after a seek) is still playing.
              if (event.data === YT_PLAYING) ytPlayingRef.current = true;
              else if (event.data !== YT_BUFFERING) ytPlayingRef.current = false;
              if (event.data === YT_PLAYING) ytEvents.current.onPlaying();
              else if (event.data === YT_PAUSED) ytEvents.current.onPaused();
              else if (event.data === YT_ENDED) ytEvents.current.onEnded();
              else if (event.data === YT_BUFFERING) ytEvents.current.onBuffering();
              else if (event.data === YT_CUED) ytEvents.current.onCued();
            },
            onError: (event: { data: number }) => ytEvents.current.onError(event.data),
          },
        });
        // Created on this single video; onReady hands YouTube the item's playlist run.
        ytRunRef.current = null;
        ytAtRef.current = { index, videoId, request: playRequestRef.current };
        ytPendingRef.current = null;
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(
            'Il player ufficiale YouTube non si è caricato. Controlla la connessione.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [youtubeActive, currentTrack?.qualifiedId, ytRequest]);

  // Destroy the YouTube player when no YouTube track is active any more.
  useEffect(() => {
    if (youtubeActive) return;
    ytPlayingRef.current = false;
    try {
      ytPlayerRef.current?.destroy();
    } catch {
      // Already removed from the DOM.
    }
    ytPlayerRef.current = null;
    ytRunRef.current = null;
    ytAtRef.current = null;
    ytPendingRef.current = null;
  }, [youtubeActive]);

  // Poll the IFrame player for progress (it exposes no timeupdate event).
  useEffect(() => {
    if (!youtubeActive || status !== 'playing') return;
    const timer = window.setInterval(() => {
      const yt = ytPlayerRef.current;
      if (!yt) return;
      try {
        ytEvents.current.onProgress(yt.getCurrentTime(), yt.getDuration());
      } catch {
        // Player not ready yet.
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [status, youtubeActive]);

  // YouTube's terms: no background playback. Pause when Solco is hidden; a video that was playing
  // gets the "video fermato" notice (with the Audius alternative) when the listener is back.
  useEffect(() => {
    if (!youtubeActive) return;
    const pauseHidden = () => {
      if (document.visibilityState === 'visible') return;
      const track = currentTrackRef.current;
      // The engine state, not the React status: a re-buffering video counts as playing, a video
      // the listener just paused (PAUSED not yet reported) does not.
      if (ytPlayingRef.current && track && isYouTubeTrack(track)) {
        markHiddenPause(youtubeVideoId(track));
      }
      ytPlayerRef.current?.pauseVideo();
    };
    document.addEventListener('visibilitychange', pauseHidden);
    return () => document.removeEventListener('visibilitychange', pauseHidden);
  }, [markHiddenPause, youtubeActive]);

  // A YouTube item reached while Solco was hidden starts once the listener is back.
  useEffect(() => {
    const startDeferred = () => {
      if (isPageHidden()) return;
      const deferred = deferredVideoRef.current;
      if (!deferred) return;
      deferredVideoRef.current = null;
      const track = currentTrackRef.current;
      if (track?.qualifiedId === deferred) void playCurrentTrack(track);
    };
    document.addEventListener('visibilitychange', startDeferred);
    return () => document.removeEventListener('visibilitychange', startDeferred);
  }, [playCurrentTrack]);

  useEffect(() => {
    document.body.classList.toggle('has-video-dock', youtubeActive);
    return () => document.body.classList.remove('has-video-dock');
  }, [youtubeActive]);

  useEffect(() => {
    document.body.classList.toggle('has-music-player', Boolean(currentTrack) && !hidePlayer);
    if (hidePlayer && currentTrack) stopPlayback();
    return () => document.body.classList.remove('has-music-player');
  }, [currentTrack, hidePlayer, stopPlayback]);

  // Apertura: il focus va nel player a schermo intero; chiusura: torna al mini player, se il focus
  // era nel player (che ora è nascosto) e non altrove (es. un cambio di pagina).
  const wasFullRef = useRef(false);
  useEffect(() => {
    const wasFull = wasFullRef.current;
    wasFullRef.current = showFull;
    if (showFull && !wasFull) fullCollapseRef.current?.focus({ preventScroll: true });
    if (!showFull && wasFull) {
      const active = document.activeElement;
      if (!active || active === document.body)
        miniExpandRef.current?.focus({ preventScroll: true });
    }
  }, [showFull]);

  useEffect(() => {
    document.body.classList.toggle('music-player-expanded', showFull);
    if (!showFull) return () => document.body.classList.remove('music-player-expanded');
    const onKey = (event: KeyboardEvent) => {
      // Un menu aperto (Condividi, Ascolta altrove) gestisce Escape da sé: chiude solo il menu.
      if (event.key === 'Escape' && !event.defaultPrevented) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('music-player-expanded');
    };
  }, [showFull]);

  // Premium state and Free counters; re-checked when the listener comes back (e.g. after
  // subscribing in another tab).
  useEffect(() => {
    const check = () => void loadAccess();
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [loadAccess]);

  // Network back after a drop: resume live radio automatically, and an on-demand item stopped
  // because the device was offline (once, from where it stopped: see handleError).
  useEffect(() => {
    const resume = () => {
      if (!currentTrack || status !== 'error' || previewEnded) return;
      if (isLiveTrack(currentTrack)) {
        reconnectsRef.current = 0;
        void playCurrentTrack(currentTrack);
        return;
      }
      if (
        offlineResumeRef.current === currentTrack.qualifiedId ||
        dropResumeRef.current === currentTrack.qualifiedId
      ) {
        offlineResumeRef.current = null;
        dropResumeRef.current = null;
        void playCurrentTrack(currentTrack);
      }
    };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, [currentTrack, playCurrentTrack, previewEnded, status]);

  // Ritorno in primo piano dopo un calo di rete in background: un brano on-demand (brani in evidenza
  // compresi) fermato mentre suonava riparte da solo dal punto salvato quando lo schermo si riaccende o
  // la scheda torna visibile/a fuoco. Non tocca i blocchi del limite Free (status resta 'idle', non
  // 'error') né la diretta radio (già gestita da 'online').
  useEffect(() => {
    const resumeOnReturn = () => {
      if (isPageHidden()) return;
      if (!currentTrack || status !== 'error' || previewEnded) return;
      if (dropResumeRef.current !== currentTrack.qualifiedId) return;
      dropResumeRef.current = null;
      void playCurrentTrack(currentTrack);
    };
    document.addEventListener('visibilitychange', resumeOnReturn);
    window.addEventListener('focus', resumeOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', resumeOnReturn);
      window.removeEventListener('focus', resumeOnReturn);
    };
  }, [currentTrack, playCurrentTrack, previewEnded, status]);

  // Restore the last queue (paused) after a reload or when reopening the app — only for the account
  // that saved it. Waits for the session: a guest (e.g. on /login after "Esci") or another account
  // never sees the previous listener's queue, and the stale copy is deleted.
  useEffect(() => {
    if (restoredRef.current || process.env.NODE_ENV === 'test' || !authKnown) return;
    restoredRef.current = true;
    let saved: { owner?: unknown; queue?: unknown; index?: unknown; position?: unknown } | null =
      null;
    try {
      saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      // Corrupt or unavailable storage: start empty.
      return;
    }
    if (!saved) return;
    if (authUserId === null || saved.owner !== authUserId) {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Storage unavailable: nothing to clear.
      }
      return;
    }
    if (!Array.isArray(saved.queue) || saved.queue.length === 0) return;
    if (typeof saved.index !== 'number') return;
    const savedQueue = saved.queue as MusicPlayerTrack[];
    const savedPosition = typeof saved.position === 'number' ? saved.position : null;
    const request = playRequestRef.current;
    const apply = (items: MusicPlayerTrack[], index: number, position: number | null) => {
      // Solo in un player vuoto: se l'ascoltatore ha già avviato qualcosa (sessione arrivata in
      // ritardo), la coda salvata non sostituisce coda, titolo e schermata di blocco di ciò che suona.
      if (request !== playRequestRef.current || currentTrackRef.current) return;
      // Un brano di audio.com salvato con l'id storico `upload:audiocom~<id>` torna in coda come
      // `audiocom:<id>`: suona ancora, ma con accesso e conteggio Free (withCurrentPlayId).
      const restored = items
        .map((item) => {
          const path = item ? trackStreamPath(item) : null;
          return path ? { ...withCurrentPlayId(item), streamPath: path } : null;
        })
        .filter((item): item is ActiveTrack => item !== null);
      const track = restored[index];
      if (!track) return;
      setQueue(restored);
      setQueueIndex(index);
      setCurrentTrack(track);
      setStatus('idle');
      if (!isLiveTrack(track) && position !== null && position > 5) {
        // YouTube (e i brani importati, che diventano video) non usano mai questo punto.
        if (!isYouTubeTrack(track) && track.playbackMode !== 'song') {
          pendingSeekRef.current = { qualifiedId: track.qualifiedId, seconds: position };
        }
        setElapsedSeconds(position);
      }
    };
    if (!savedQueue.some((item) => item?.playbackMode === 'local')) {
      apply(savedQueue, saved.index, savedPosition);
      return;
    }
    // The saved queue holds only the ids of the listener's own files: titles, artists and albums
    // are read again from IndexedDB on this device, and files no longer there leave the queue.
    void restoreLocalItems(savedQueue, saved.index, getTrack).then((restored) => {
      // The listener started something meanwhile: that wins.
      if (!restored || request !== playRequestRef.current || currentTrackRef.current) return;
      apply(restored.items, restored.index, restored.sameTrack ? savedPosition : null);
    });
  }, [authKnown, authUserId, setElapsedSeconds]);

  // Save queue and position, tagged with the account it belongs to: when the queue changes and
  // every 5 s of progress. Il tempo arriva dallo store: per salvarlo il provider non si ridisegna.
  const saveQueue = () => {
    if (!restoredRef.current || !currentTrack || queueIndex < 0 || !authUserId) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          owner: authUserId,
          // A local file is saved as its id only (see persistedQueueItem): its tags stay in
          // IndexedDB, and nothing of this queue is ever sent to the server.
          queue: queue
            .slice(0, 100)
            .map(({ streamPath: _path, ...item }) => persistedQueueItem(item)),
          index: queueIndex,
          position: isLiveTrack(currentTrack) ? 0 : elapsedStore.get(),
        }),
      );
    } catch {
      // Quota or private mode: persistence is best-effort.
    }
  };
  const saveQueueRef = useRef(saveQueue);
  saveQueueRef.current = saveQueue;
  // biome-ignore lint/correctness/useExhaustiveDependencies: saves when the queue or its item changes; progress below.
  useEffect(() => {
    saveQueueRef.current();
  }, [currentTrack, queue, queueIndex]);
  useEffect(() => {
    let bucket = Math.floor(elapsedStore.get() / 5);
    return elapsedStore.subscribe(() => {
      const next = Math.floor(elapsedStore.get() / 5);
      if (next === bucket) return;
      bucket = next;
      saveQueueRef.current();
    });
  }, [elapsedStore]);
  // Pausa, app in background o chiusa: salva subito il punto (non solo ogni 5 s di ascolto).
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') saveQueueRef.current();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // Navigating to another page collapses the full-screen player.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to route changes only.
  useEffect(() => {
    setExpanded(false);
  }, [pathname]);

  // Now Playing metadata, once per item (iOS lock screen and Control Center, Android notification).
  useEffect(() => {
    showNowPlaying(currentTrack);
    const audio = decks.current;
    if (
      currentTrack &&
      audio &&
      audio.getAttribute('src') === deckSource(currentTrack, localAudioRef.current) &&
      audio.readyState >= HAVE_METADATA
    ) {
      // Gapless swap: the former spare loaded this item's metadata while it was the spare (events
      // ignored then), and its 'playing' may have run before this effect. Re-sync, do not clear.
      syncPositionStateRef.current();
    } else {
      // A new item starts without a scrubber until its own metadata loads (see syncPositionState).
      applyPositionState(mediaSessionOrNull(), null);
    }
    if (!currentTrack) setSessionPlaybackState('none');
  }, [currentTrack, decks, showNowPlaying]);

  // Local object URLs follow the item: once another item is current, the files no longer current
  // or prepared as the next one are revoked (never right after play(): some engines re-read the
  // Blob while seeking). Closing the player keeps none.
  const currentItemId = currentTrack?.qualifiedId ?? null;
  const currentLocalId = currentTrack && isLocalTrack(currentTrack) ? currentItemId : null;
  useEffect(() => {
    const keep = new Set<string>();
    if (currentItemId) keep.add(currentItemId);
    if (decks.spare) keep.add(decks.spare.qualifiedId);
    if (preparedRef.current) keep.add(preparedRef.current.qualifiedId);
    pruneLocalSources(keep);
  }, [currentItemId, decks, pruneLocalSources]);

  // The cover of the current local item: its own object URL, revoked when the item changes.
  useEffect(() => {
    const id = currentLocalId ? localTrackId(currentLocalId) : null;
    if (!currentLocalId || !id) return;
    let cancelled = false;
    let handle: ObjectUrlHandle | null = null;
    void createObjectUrlForArtwork(id)
      .catch(() => null)
      .then((created) => {
        if (cancelled) {
          created?.revoke();
          return;
        }
        if (!created) return;
        handle = created;
        const artwork = { qualifiedId: currentLocalId, url: created.url };
        localArtworkRef.current = artwork;
        setLocalArtwork(artwork);
        // The lock screen and the Android notification get the cover too.
        const track = currentTrackRef.current;
        if (track?.qualifiedId === currentLocalId) showNowPlaying(track);
      });
    return () => {
      cancelled = true;
      const revoked = handle;
      if (!revoked) return;
      if (localArtworkRef.current?.url === revoked.url) localArtworkRef.current = null;
      setLocalArtwork((current) => (current?.url === revoked.url ? null : current));
      revoked.revoke();
    };
  }, [currentLocalId, showNowPlaying]);

  // A local file that is gone or unplayable: skipped once this render has the queue (skipLocalRef).
  useEffect(() => {
    if (!localSkip) return;
    setLocalSkip(null);
    skipLocalRef.current(localSkip);
  }, [localSkip]);

  // Unmounted: every object URL of the listener's files is revoked.
  useEffect(() => {
    unmountedRef.current = false;
    const localAudio = localAudioRef.current;
    return () => {
      unmountedRef.current = true;
      for (const handle of localAudio.values()) handle.revoke();
      localAudio.clear();
    };
  }, []);

  // System controls for this kind of item; set again on every 'playing' (see handlePlaying).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the plan is read from sessionPlanRef; these values change it.
  useEffect(() => {
    registerSystemControls();
  }, [
    registerSystemControls,
    currentTrack?.qualifiedId,
    currentTrack?.playbackMode,
    hasNext,
    queueIndex,
  ]);

  // Unmounted: no handler or pending reconnect may point at a dead player, and nothing keeps
  // sounding (e.g. the login wall unmounts the provider after the session ends).
  useEffect(() => {
    // Captured now: at unmount React has already detached the deck refs (decks.current is null
    // then), so releasing "the current deck" would release nothing.
    const elements = [decks.current, decks.spareDeck];
    return () => {
      playRequestRef.current += 1;
      clearTimer(reconnectTimerRef);
      clearTimer(stallTimerRef);
      for (const element of elements) {
        // A deck with no source holds nothing to release.
        if (!element?.getAttribute('src')) continue;
        try {
          releaseDeck(element);
        } catch {
          // Element already gone.
        }
      }
      // The official YouTube player and its callbacks must not outlive the provider.
      try {
        ytPlayerRef.current?.destroy();
      } catch {
        // Already removed from the DOM.
      }
      ytPlayerRef.current = null;
      // Nothing plays any more: other apps may take the audio again, and the lock screen or the
      // Android notification must not keep showing a "playing" item with dead buttons.
      releasePlaybackSession();
      const session = mediaSessionOrNull();
      if (!session) return;
      for (const action of MEDIA_SESSION_ACTIONS) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Unsupported action; there is no handler to remove.
        }
      }
      try {
        session.metadata = null;
      } catch {
        // Read-only in some engines.
      }
      applyPositionState(session, null);
      setSessionPlaybackState('none');
    };
  }, [decks]);

  // A stopped, failed or blocked item shows as paused (play retries it); 'none' only when closed.
  useEffect(() => {
    if (currentTrack && (status === 'error' || status === 'idle' || status === 'ended')) {
      setSessionPlaybackState('paused');
    }
  }, [currentTrack, status]);

  // Shuffle, repeat or the queue changed what comes next: a spare holding another track stops.
  useEffect(() => {
    const held = decks.spare;
    if (!held) return;
    const index = repeat === 'one' ? null : followingIndex(repeat === 'all');
    if (index === null || index !== held.index || queue[index]?.qualifiedId !== held.qualifiedId) {
      releaseSpare();
    }
  }, [decks, followingIndex, queue, releaseSpare, repeat]);

  // Repeat one: the element loops by itself and never reaches 'ended' (no gap, no new request).
  useEffect(() => {
    const audio = decks.current;
    if (!audio) return;
    audio.loop =
      repeat === 'one' &&
      Boolean(currentTrack) &&
      !isLiveTrack(currentTrack) &&
      !isYouTubeTrack(currentTrack);
  }, [currentTrack, decks, repeat]);

  // "Rimuovi video" senza una versione solo audio: il video (e la sua musica, YouTube non consente
  // l'audio senza video) se ne va. Si passa al brano successivo della coda, altrimenti si chiude.
  // Se nel frattempo il brano è cambiato (il video è finito, l'utente ne ha scelto un altro), nulla.
  const removeVideoWithoutAudio = (videoId: string): 'next' | 'stopped' | 'stale' => {
    if (currentTrackRef.current?.qualifiedId !== `youtube:${videoId}`) return 'stale';
    const index = followingIndex(repeat === 'all');
    if (index !== null && index !== queueIndex) {
      void playQueueIndex(index);
      return 'next';
    }
    stopPlayback();
    return 'stopped';
  };

  // The YouTube video on screen, offered as the same song on Audius ("Ascolta in background").
  const backgroundVideo =
    currentTrack && currentVideoId && youtubeActive
      ? {
          videoId: currentVideoId,
          title: currentTrack.title,
          channelTitle: currentTrack.artistName ?? '',
        }
      : null;
  // Play/pause of the same player view (disabled while loading: then its never-disabled neighbour).
  const noticeFocusTarget = (placement: 'dock' | 'full') => () => {
    const play = placement === 'dock' ? miniPlayRef.current : fullPlayRef.current;
    if (play && !play.disabled && play.getAttribute('aria-disabled') !== 'true') return play;
    return placement === 'dock' ? miniExpandRef.current : fullCollapseRef.current;
  };
  const returnNoticeFor = (placement: 'dock' | 'full') =>
    backgroundVideo && noticeVideoId === backgroundVideo.videoId ? (
      <BackgroundSwitchNotice
        key={backgroundVideo.videoId}
        video={backgroundVideo}
        onResume={() => void controlsRef.current.resume()}
        onDismiss={dismissReturnNotice}
        focusTarget={noticeFocusTarget(placement)}
        className={
          placement === 'dock' ? `${noticeStyles.inDock} ${styles.videoNotice}` : undefined
        }
      />
    ) : null;
  const errorLink = failureLink(errorMessage, currentTrack);
  // Testo: solo brani in evidenza, upload degli utenti e file del dispositivo (mai Audius,
  // YouTube, radio, podcast): il server decide poi se il brano ha davvero un testo autorizzato.
  const lyricsTarget = lyricsTargetFor(currentTrack);
  // Un brano in evidenza della Home usa il suo conteggio (30 avvii al mese con Free): contatore e
  // messaggio di blocco mostrano quei numeri, non i 40 del catalogo.
  const featuredCurrent = currentTrack !== null && isFeaturedPlayId(currentTrack.qualifiedId);
  const counterUsed = featuredCurrent ? featuredPlaysUsed : playsUsed;
  const counterLimit = featuredCurrent ? featuredPlaysLimit : playsLimit;
  const showCounter =
    counterLimit !== null &&
    counterUsed !== null &&
    showsFreePlayCounter(currentTrack?.playbackMode, currentTrack?.qualifiedId);

  // Both decks get the same attributes; only the active one drives the player (see onActiveDeck).
  const renderDeck = (bind: (element: HTMLAudioElement | null) => void) => (
    <audio
      ref={bind}
      hidden
      preload="none"
      aria-hidden="true"
      tabIndex={-1}
      // Status follows the element: 'playing' only once audio really flows, not on play().
      onPlaying={onActiveDeck(handlePlaying)}
      onPause={onActiveDeck(handlePause)}
      onWaiting={onActiveDeck(() => {
        setBuffering(true);
        watchLiveStall();
      })}
      onStalled={onActiveDeck(watchLiveStall)}
      onSeeking={onActiveDeck(() => restartListeningSample(listeningRef.current))}
      onSeeked={onActiveDeck(syncPositionState)}
      onRateChange={onActiveDeck(syncPositionState)}
      onTimeUpdate={onActiveDeck(handleTimeUpdate)}
      onDurationChange={onActiveDeck(handleDurationChange)}
      onLoadedMetadata={onActiveDeck(handleLoadedMetadata)}
      onEnded={onActiveDeck(handleEnded)}
      onError={handleDeckError}
    >
      <track kind="captions" src="/music-captions.vtt" srcLang="it" label="Musica" />
    </audio>
  );

  // Covers: a local file's comes from the player's own object URL (current item only).
  const artworkOf = (item: MusicPlayerTrack) =>
    isLocalTrack(item)
      ? localArtwork?.qualifiedId === item.qualifiedId
        ? localArtwork.url
        : null
      : (item.artworkUrl ?? null);
  const currentArtwork = currentTrack ? artworkOf(currentTrack) : null;
  const playLabel = currentTrack
    ? status === 'playing'
      ? `Metti in pausa ${currentTrack.title}`
      : `Riproduci ${currentTrack.title}`
    : '';
  const repeatLabel =
    repeat === 'off'
      ? 'Ripeti: disattivato'
      : repeat === 'all'
        ? 'Ripeti: tutta la coda'
        : 'Ripeti: solo questo brano';

  // Stesso oggetto finché non cambia qualcosa che i consumer mostrano: il tempo trascorso non c'è
  // (useMusicPlayerElapsed), quindi l'avanzamento non ridisegna chi legge useMusicPlayer().
  const playerValue = useMemo<MusicPlayerValue>(
    () => ({
      currentTrack,
      status,
      durationSeconds,
      queue,
      queueIndex,
      errorMessage,
      shuffle,
      repeat,
      autoplay,
      playbackSpeed,
      expanded,
      premium,
      previewEnded,
      playBlock,
      playsUsed,
      playsLimit,
      featuredPlaysUsed,
      featuredPlaysLimit,
      playTrack,
      togglePlayback,
      previousTrack,
      nextTrack,
      seekTo,
      stopPlayback,
      forgetLocalTracks,
      toggleShuffle,
      cycleRepeat,
      toggleAutoplay,
      setSpeed: setPlaybackSpeed,
      setExpanded,
      primeAudio,
      isCurrentTrack,
      replaceCurrentTrack,
    }),
    [
      currentTrack,
      status,
      durationSeconds,
      queue,
      queueIndex,
      errorMessage,
      shuffle,
      repeat,
      autoplay,
      playbackSpeed,
      expanded,
      premium,
      previewEnded,
      playBlock,
      playsUsed,
      playsLimit,
      featuredPlaysUsed,
      featuredPlaysLimit,
      playTrack,
      togglePlayback,
      previousTrack,
      nextTrack,
      seekTo,
      stopPlayback,
      forgetLocalTracks,
      toggleShuffle,
      cycleRepeat,
      toggleAutoplay,
      primeAudio,
      isCurrentTrack,
      replaceCurrentTrack,
    ],
  );

  return (
    <MusicPlayerContext.Provider value={playerValue}>
      <MusicPlayerElapsedContext.Provider value={elapsedStore}>
        {children}
      </MusicPlayerElapsedContext.Provider>
      {renderDeck(decks.bindFirst)}
      {GAPLESS_DECKS_ENABLED ? renderDeck(decks.bindSecond) : null}
      {currentTrack && !hidePlayer ? (
        <>
          {youtubeActive ? (
            <div
              className={`${styles.videoDock} ${showFull ? styles.videoDockExpanded : ''}`}
              data-youtube-official-frame
            >
              {showFull ? null : (
                <div className={styles.videoBar}>
                  <span className={styles.videoBarTitle}>{currentTrack.title}</span>
                  {backgroundVideo ? (
                    <RemoveVideoButton
                      compact
                      video={backgroundVideo}
                      onRemoveWithoutAudio={removeVideoWithoutAudio}
                      className={styles.videoRemove}
                    />
                  ) : null}
                  <button
                    type="button"
                    className={styles.videoClose}
                    onClick={stopPlayback}
                    aria-label="Chiudi il video e ferma il player"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              )}
              <div ref={ytHostRef} className={styles.videoHost} />
              {/* Below the official player, never over it (YouTube forbids overlays). */}
              {showFull ? null : returnNoticeFor('dock')}
            </div>
          ) : null}
          <aside
            className={styles.mini}
            aria-label="Player musicale Solco"
            aria-busy={status === 'loading' || buffering}
            data-status={status}
            data-solco-player
          >
            {/* Fulmini: lampi soffusi durante la riproduzione, per tutti gli utenti. */}
            <span className={styles.lightning} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <button
              ref={miniExpandRef}
              type="button"
              className={styles.miniExpand}
              onClick={() => setExpanded(true)}
              aria-label={`Apri il player: ${currentTrack.title}`}
              aria-expanded={showFull}
            >
              <span className={styles.miniArt} aria-hidden="true">
                <Artwork track={currentTrack} size={44} url={currentArtwork} />
                <span className={styles.eq} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className={styles.miniCopy}>
                <strong>{currentTrack.title}</strong>
                <span>
                  {!live && Math.abs(playbackSpeed - 1) > 0.001 ? (
                    <em className={styles.speedBadge}>{playbackSpeed}×</em>
                  ) : null}
                  {live ? <em className={styles.liveBadge}>LIVE</em> : null}
                  {[currentTrack.artistName, currentTrack.sourceLabel].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
            <div className={styles.miniButtons}>
              {backgroundVideo ? (
                <BackgroundListenButton
                  video={backgroundVideo}
                  hint="continua con lo schermo bloccato"
                  className={styles.miniBackground}
                />
              ) : null}
              <button
                ref={miniPlayRef}
                className={styles.miniControl}
                type="button"
                onClick={() => {
                  if (status !== 'loading') void togglePlayback();
                }}
                // aria-disabled, non disabled: il pulsante appena premuto non perde il focus.
                aria-disabled={status === 'loading'}
                aria-label={playLabel}
              >
                <PlayStateIcon status={status} buffering={buffering} />
              </button>
              <button
                className={styles.miniSkip}
                type="button"
                onClick={() => void nextTrack()}
                disabled={!hasNext}
                aria-label="Brano successivo"
              >
                <SkipForward aria-hidden="true" />
              </button>
              <button
                className={`${styles.miniSkip} ${styles.miniAutoplay}`}
                type="button"
                onClick={toggleAutoplay}
                aria-pressed={autoplay}
                aria-label="Autoplay continuo: a coda finita continua con brani consigliati"
                title="Autoplay continuo"
              >
                <InfinityIcon aria-hidden="true" />
              </button>
              <button
                className={styles.miniSkip}
                type="button"
                onClick={stopPlayback}
                aria-label="Chiudi il player"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {playBlock ? (
              <output className={styles.upsell} aria-live="polite">
                {playBlock === 'login_required' ? (
                  <>
                    {/* Link client-side: una navigazione completa smonterebbe il player. */}
                    Per ascoltare serve un account gratuito. <Link href="/signup">Registrati</Link>{' '}
                    o <Link href="/login">accedi</Link>.
                  </>
                ) : featuredCurrent ? (
                  <>
                    Hai usato i {featuredPlaysLimit ?? FEATURED_FREE_MONTHLY_PLAYS} ascolti gratuiti
                    dei brani in evidenza di questo mese: il conteggio riparte il mese prossimo.
                    Puoi continuare con brani Audius, podcast, radio e video YouTube.
                  </>
                ) : (
                  <>
                    Hai usato i {playsLimit ?? 40} ascolti gratuiti di questo mese.{' '}
                    <Link href="/piani">Passa a Premium per ascolti illimitati</Link>.
                  </>
                )}
              </output>
            ) : null}
            {errorMessage && !showFull ? (
              <output className={styles.miniError} aria-live="polite">
                {errorMessage}
                {errorLink ? (
                  <>
                    {' '}
                    <a href={errorLink.href} target="_blank" rel="noreferrer">
                      {errorLink.label}
                    </a>
                  </>
                ) : null}
              </output>
            ) : null}
            <MiniProgress store={elapsedStore} duration={durationSeconds} live={live} />
          </aside>

          <section
            className={`${styles.full} ${youtubeActive ? styles.fullVideo : ''}`}
            aria-label="Player a schermo intero"
            data-status={status}
            data-solco-player
            hidden={!showFull}
            inert={!showFull}
          >
            {/* Fulmini: lampi soffusi durante la riproduzione, per tutti gli utenti. */}
            <span className={styles.lightning} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {!youtubeActive && currentArtwork ? (
              <div className={styles.fullBackdrop} aria-hidden="true">
                {/* Copertina sfocata come sfondo (solo fonti audio). La musica non si ferma. */}
                {/* biome-ignore lint/performance/noImgElement: sfondo decorativo sfocato, next/image superfluo. */}
                <img src={currentArtwork} alt="" loading="lazy" decoding="async" />
              </div>
            ) : null}
            <header className={styles.fullHeader}>
              <button
                ref={fullCollapseRef}
                type="button"
                className={styles.iconButton}
                onClick={() => setExpanded(false)}
                aria-label="Riduci il player"
              >
                <ChevronDown aria-hidden="true" />
              </button>
              <span className={styles.playerLabel}>
                ORA IN ASCOLTO · {currentTrack.sourceLabel}
              </span>
              <button
                className={styles.iconButton}
                type="button"
                onClick={stopPlayback}
                aria-label="Chiudi player"
              >
                <X aria-hidden="true" />
              </button>
            </header>

            <div className={styles.fullBody}>
              {youtubeActive ? null : (
                <div className={styles.fullArt}>
                  <Artwork track={currentTrack} size={480} url={currentArtwork} />
                </div>
              )}

              <div className={styles.trackCopy}>
                {showFull ? returnNoticeFor('full') : null}
                <strong title={currentTrack.title}>{currentTrack.title}</strong>
                <span className={styles.trackMeta}>
                  {live ? <em className={styles.liveBadge}>LIVE</em> : null}
                  {[currentTrack.artistName, currentTrack.sourceLabel].filter(Boolean).join(' · ')}
                </span>
                {showCounter && counterLimit !== null && counterUsed !== null ? (
                  <p className={styles.adNote}>
                    {featuredCurrent
                      ? 'Ascolti gratuiti dei brani in evidenza questo mese'
                      : 'Ascolti gratuiti questo mese'}
                    : {Math.min(counterUsed, counterLimit)} di {counterLimit}.
                    {featuredCurrent ? null : (
                      <>
                        {' '}
                        {/* Link client-side: con <a> la pagina si ricaricava e la musica si fermava. */}
                        <Link href="/piani">Illimitati con Premium</Link>
                      </>
                    )}
                  </p>
                ) : null}
                {backgroundVideo ? (
                  <BackgroundListenButton
                    compact={false}
                    video={backgroundVideo}
                    hint="continua con lo schermo bloccato"
                  />
                ) : null}
                {backgroundVideo ? (
                  <RemoveVideoButton
                    video={backgroundVideo}
                    onRemoveWithoutAudio={removeVideoWithoutAudio}
                    className={styles.removeVideo}
                  />
                ) : null}
                {youtubeActive ? (
                  <p className={styles.adNote}>
                    Eventuali annunci nei video sono di YouTube: Solco non li controlla. Con YouTube
                    Premium, se hai effettuato l’accesso a YouTube in questo browser, non li vedi.
                  </p>
                ) : null}
                <span className={styles.links}>
                  {shareTarget ? (
                    <ShareMenu
                      size="sm"
                      title={shareTarget.title}
                      text={shareTarget.text}
                      url={shareTarget.url}
                      imageUrl={shareTarget.imageUrl}
                      ariaLabel={`Condividi ${shareTarget.title}`}
                      contentClassName={FULL_PLAYER_MENU}
                    />
                  ) : null}
                  {quizTarget ? (
                    <ShareMenu
                      size="sm"
                      label="Sfida un amico"
                      title={QUIZ_SHARE_TITLE}
                      text={quizTarget.text}
                      url={quizTarget.url}
                      imageUrl={quizTarget.imageUrl}
                      ariaLabel={`Sfida un amico: chi interpreta ${quizTarget.title}?`}
                      contentClassName={FULL_PLAYER_MENU}
                    />
                  ) : null}
                  <YouTubePremiumButton videoId={songSearchVideoId} />
                  {currentTrack.sourceUrl ? (
                    <a href={currentTrack.sourceUrl} target="_blank" rel="noreferrer">
                      {currentTrack.sourceUrlLabel ?? `Apri la fonte ${currentTrack.sourceLabel}`}{' '}
                      <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
                  {currentTrack.artistUrl ? (
                    <a href={currentTrack.artistUrl} target="_blank" rel="noreferrer">
                      Profilo artista Audius <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
                </span>
                {lyricsTarget ? (
                  <button
                    type="button"
                    className={lyricsStyles.toggle}
                    aria-pressed={lyricsOpen}
                    onClick={() => {
                      lyricsRevealRef.current = !lyricsOpen;
                      setLyricsOpen(!lyricsOpen);
                    }}
                  >
                    <MicVocal aria-hidden="true" />
                    Testo
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.dataSaverToggle}
                  aria-pressed={dataSaver}
                  onClick={() => setDataSaver(!dataSaver)}
                  title="Non precarica l'audio del brano successivo: meno dati, con una piccola pausa al cambio brano. Non cambia la qualità."
                >
                  <span className={styles.dataSaverDot} aria-hidden="true" />
                  Risparmio dati · {dataSaver ? 'attivo' : 'spento'}
                </button>
                {errorMessage ? (
                  <output className={styles.playerError} aria-live="polite">
                    {errorMessage}
                    {errorLink ? (
                      <>
                        {' '}
                        <a href={errorLink.href} target="_blank" rel="noreferrer">
                          {errorLink.label}
                        </a>
                      </>
                    ) : null}
                  </output>
                ) : null}
              </div>

              <div className={styles.playerControls}>
                <SeekBar
                  store={elapsedStore}
                  duration={durationSeconds}
                  onSeek={seekTo}
                  disabled={live || durationSeconds <= 0 || status === 'loading'}
                  label={
                    live
                      ? 'Diretta radio: avanzamento non disponibile'
                      : isLocalTrack(currentTrack)
                        ? 'Avanzamento brano'
                        : 'Avanzamento brano Audius'
                  }
                />
                <span className={styles.time}>
                  <ElapsedTime store={elapsedStore} />
                  <span>
                    {live
                      ? 'In diretta'
                      : durationSeconds
                        ? formattedTime(durationSeconds)
                        : '--:--'}
                  </span>
                </span>
                <div className={styles.buttons}>
                  <button
                    className={styles.toggle}
                    type="button"
                    onClick={toggleShuffle}
                    aria-pressed={shuffle}
                    aria-label="Riproduzione casuale"
                    disabled={queue.length < 2}
                  >
                    <Shuffle aria-hidden="true" />
                  </button>
                  <PreviousButton
                    store={elapsedStore}
                    firstItem={queueIndex <= 0}
                    live={live}
                    onPrevious={() => void previousTrack()}
                  />
                  <button
                    ref={fullPlayRef}
                    className={styles.control}
                    type="button"
                    onClick={() => {
                      if (status !== 'loading') void togglePlayback();
                    }}
                    aria-disabled={status === 'loading'}
                    aria-label={playLabel}
                  >
                    <PlayStateIcon status={status} buffering={buffering} />
                  </button>
                  <button
                    className={styles.skip}
                    type="button"
                    onClick={() => void nextTrack()}
                    disabled={!hasNext}
                    aria-label="Brano successivo"
                  >
                    <SkipForward aria-hidden="true" />
                  </button>
                  <button
                    className={styles.toggle}
                    type="button"
                    onClick={cycleRepeat}
                    aria-pressed={repeat !== 'off'}
                    aria-label={repeatLabel}
                    disabled={live}
                  >
                    {repeat === 'one' ? (
                      <Repeat1 aria-hidden="true" />
                    ) : (
                      <Repeat aria-hidden="true" />
                    )}
                  </button>
                  <button
                    className={styles.toggle}
                    type="button"
                    onClick={toggleAutoplay}
                    aria-pressed={autoplay}
                    aria-label="Autoplay continuo: a coda finita continua con brani consigliati"
                    title="Autoplay continuo"
                  >
                    <InfinityIcon aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.speed}>
                  <span className={styles.speedLabel}>
                    <Gauge aria-hidden="true" /> Velocità (slowed / sped up)
                  </span>
                  <div className={styles.speedChips}>
                    {PLAYBACK_SPEEDS.map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={styles.speedChip}
                        aria-pressed={Math.abs(playbackSpeed - value) < 0.001}
                        aria-label={value === 1 ? 'Velocità normale' : `Velocità ${value}×`}
                        onClick={() => setPlaybackSpeed(value)}
                        disabled={live}
                      >
                        {value === 1 ? '1×' : `${value}×`}
                      </button>
                    ))}
                  </div>
                  {youtubeActive && Math.abs(playbackSpeed - 1) > 0.001 ? (
                    <p className={styles.speedHint}>Su YouTube cambia la velocità, non il tono.</p>
                  ) : null}
                </div>
              </div>

              {lyricsOpen && lyricsTarget && showFull ? (
                <LyricsPanel
                  source={lyricsTarget.source}
                  id={lyricsTarget.id}
                  getTime={getLyricsTime}
                  onSeek={seekTo}
                  consumeReveal={consumeLyricsReveal}
                  premium={premium === true}
                  trackTitle={currentTrack?.title}
                  trackArtist={currentTrack?.artistName}
                />
              ) : null}

              <details className={styles.queue} open>
                <summary>
                  <ListMusic aria-hidden="true" /> Coda · {queue.length} brani
                </summary>
                <ol>
                  {queue.map((item, index) => {
                    const art = artworkOf(item);
                    return (
                      <li key={`${index}-${item.qualifiedId}`}>
                        <div className={styles.queueItem}>
                          <span className={styles.queueArtwork}>
                            {art ? (
                              <Image src={art} alt="" width={36} height={36} unoptimized />
                            ) : (
                              <Music2 aria-hidden="true" />
                            )}
                          </span>
                          <button
                            type="button"
                            aria-current={index === queueIndex ? 'true' : undefined}
                            onClick={() => void playQueueIndex(index)}
                          >
                            <strong>{item.title}</strong>
                            <span>{item.artistName}</span>
                          </button>
                          {item.artistUrl ? (
                            <a href={item.artistUrl} target="_blank" rel="noreferrer">
                              Profilo Audius
                            </a>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </details>
            </div>
          </section>
        </>
      ) : null}
    </MusicPlayerContext.Provider>
  );
}
