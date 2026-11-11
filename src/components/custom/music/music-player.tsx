// @polsia:user-owned — player unico condiviso tra le pagine: mini player + player a schermo intero.
'use client';

import {
  ChevronDown,
  ExternalLink,
  ListMusic,
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
import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { apiFetch } from '@/lib/api-client';
import { soundcloudSearchUrl, spotifySearchUrl } from '@/lib/business/shared-song';
import { AudiusPlaybackCheckSchema } from '@/lib/contracts/music';
import {
  declarePlaybackSession,
  primeMediaElement,
  releasePlaybackSession,
} from '@/lib/music/audio-session';
import { parseVideoTitle } from '@/lib/music/background-match';
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
import { failureLink, failureMessage, showsFreePlayCounter } from '@/lib/music/player-messages';
import { BackgroundListenButton } from './background-listen-button';
import { BackgroundSwitchNotice, useReturnNotice } from './background-switch-notice';
import noticeStyles from './background-switch-notice.module.css';
import styles from './music-player.module.css';
import { loadYouTubeIframeApi } from './youtube-queue-player';

export type MusicPlaybackMode =
  | 'audius'
  | 'solco'
  | 'radio'
  | 'podcast'
  | 'jamendo'
  | 'youtube'
  // Imported song (artist + title): found on YouTube when its turn comes, then played there.
  | 'song';

export type MusicPlayerTrack = {
  qualifiedId: string;
  title: string;
  artistName: string;
  artistUrl?: string | null;
  artworkUrl?: string | null;
  sourceLabel: string;
  sourceUrl: string | null;
  sourceUrlLabel?: string;
  durationSeconds?: number | null;
  albumId?: string | null;
  /** For a YouTube video found from an imported song: the song's qualifiedId (song:…). */
  importedFrom?: string | null;
  playbackMode?: MusicPlaybackMode;
  credits?: string[];
};

export type RepeatMode = 'off' | 'all' | 'one';

type ActiveTrack = MusicPlayerTrack & { streamPath: string };
type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

type MusicPlayerValue = {
  currentTrack: ActiveTrack | null;
  status: PlaybackStatus;
  elapsedSeconds: number;
  durationSeconds: number;
  queue: ActiveTrack[];
  queueIndex: number;
  errorMessage: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
  expanded: boolean;
  /** true: Premium, ascolti illimitati; false: Free, 40 ascolti completi al mese; null: verifica in corso. */
  premium: boolean | null;
  previewEnded: boolean;
  /** Motivo del blocco dell'ultimo avvio (account free / ospite), null se nessuno. */
  playBlock: PlayBlock | null;
  /** Ascolti usati questo mese e limite (null = illimitati). */
  playsUsed: number | null;
  playsLimit: number | null;
  playTrack: (
    track: MusicPlayerTrack,
    streamPath: string,
    queue?: MusicPlayerTrack[],
  ) => Promise<void>;
  togglePlayback: () => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack: () => Promise<void>;
  seekTo: (seconds: number) => void;
  stopPlayback: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setExpanded: (expanded: boolean) => void;
  /**
   * Da chiamare come prima istruzione di un tocco che avvierà l'audio dopo un'attesa di rete
   * (es. "Ascolta in background"): sblocca l'elemento <audio> dentro il gesto (iOS). La sessione
   * audio 'playback' viene dichiarata solo subito prima di play(), mai mentre suona un video YouTube.
   */
  primeAudio: () => void;
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
    track.playbackMode === 'youtube'
  );
}

const STORAGE_KEY = 'solco.player.v1';
const MAX_RECONNECTS = 3;
/** On-demand streams (Audius, Jamendo, podcast): one immediate retry after a network drop. */
const MAX_MEDIA_RETRIES = 1;
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
};

function accessSnapshot(body: AccessBody): AccessSnapshot {
  return {
    premium: body.premium === true,
    signedIn: body.signedIn === true,
    playsUsed: typeof body.playsUsed === 'number' ? body.playsUsed : null,
    playsLimit: typeof body.playsLimit === 'number' ? body.playsLimit : null,
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
};

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;

export function isLiveTrack(track: Pick<MusicPlayerTrack, 'playbackMode'> | null | undefined) {
  return track?.playbackMode === 'radio';
}

function safeStreamPath(path: string, track: MusicPlayerTrack) {
  if (typeof window === 'undefined') return null;
  const expected = trackStreamPath(track);
  if (!expected) return null;
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
  const match = /^audius:([A-Za-z0-9_-]{1,128})$/.exec(track.qualifiedId);
  if (!match?.[1]) return null;
  if (track.playbackMode === 'audius') {
    return `/api/music/audius/tracks/${encodeURIComponent(match[1])}/stream`;
  }
  if (track.playbackMode !== 'solco' || !track.albumId || !safeId.test(track.albumId)) return null;
  return `/api/music/albums/${encodeURIComponent(track.albumId)}/tracks/${encodeURIComponent(match[1])}/stream`;
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

async function verifyPlayback(track: MusicPlayerTrack) {
  if (isOpenStream(track)) return;
  const path = playbackPath(track);
  if (!path) throw new Error('Track is not an authorized album item');
  const verdict = await apiFetch(path, { schema: AudiusPlaybackCheckSchema });
  if (!verdict.allowed) throw new Error(verdict.reason, { cause: verdict });
}

/** Rights check prepared before the end of the previous item: GET …/playback never consumes a play. */
async function prefetchRights(track: MusicPlayerTrack): Promise<RightsVerdict> {
  const path = playbackPath(track);
  if (!path) return 'denied';
  try {
    const verdict = await apiFetch(path, { schema: AudiusPlaybackCheckSchema });
    return verdict.allowed ? 'allowed' : rightsVerdictFromReason(verdict.reason);
  } catch (error) {
    return rightsVerdictFromReason(denialReason(error));
  }
}

function formattedTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export type PlayBlock = 'login_required' | 'monthly_limit';

type PlayPermit = { allowed: boolean; reason?: PlayBlock; used?: number; limit?: number | null };

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

async function requestPlayPermit(qualifiedId: string): Promise<PlayPermit> {
  try {
    const response = await fetch('/api/music/plays', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qualifiedId }),
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
    return {
      allowed: true,
      used: typeof body.used === 'number' ? body.used : undefined,
      limit: typeof body.limit === 'number' ? body.limit : null,
    };
  } catch {
    // Network failure: let the server-side stream check decide (it enforces the same limit).
    return { allowed: true };
  }
}

/** Registra un ascolto nella cronologia della Libreria (solo utenti autenticati; errori ignorati). */
function recordPlay(track: MusicPlayerTrack) {
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

function Artwork({ track, size }: { track: MusicPlayerTrack; size: number }) {
  if (track.artworkUrl) {
    return <Image src={track.artworkUrl} alt="" width={size} height={size} unoptimized />;
  }
  return track.playbackMode === 'radio' ? (
    <Radio aria-hidden="true" />
  ) : (
    <Music2 aria-hidden="true" />
  );
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement>(null);
  const recordedRef = useRef<string | null>(null);
  const [currentTrack, setCurrentTrack] = useState<ActiveTrack | null>(null);
  const [queue, setQueue] = useState<ActiveTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [expanded, setExpanded] = useState(false);
  const ytHostRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<YouTubeEngine | null>(null);
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
  const [previewEnded, setPreviewEnded] = useState(false);
  const reconnectsRef = useRef(0);
  // Pending delayed radio reconnect (2nd and 3rd attempt): cleared on close and pause.
  const reconnectTimerRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const restoredRef = useRef(false);
  // Background playback (see src/lib/music/playback-prefetch.ts and media-session.ts).
  const accessRef = useRef<AccessSnapshot | null>(null);
  const nextPlanRef = useRef<{ key: string; index: number | null } | null>(null);
  const preparedRef = useRef<PreparedNext | null>(null);
  const startedAtRef = useRef(new Map<string, number>());
  const refreshOnPlayingRef = useRef(false);
  const deferredVideoRef = useRef<string | null>(null);
  const mediaRetryRef = useRef(0);
  const retryPositionRef = useRef(0);
  const listeningRef = useRef(createListeningClock());
  const nowPlayingRef = useRef<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const ytEvents = useRef({
    onPlaying: () => {},
    onPaused: () => {},
    onEnded: () => {},
    onError: (_code: number) => {},
    onProgress: (_elapsed: number, _duration: number) => {},
  });

  const releaseAudio = useCallback(() => {
    try {
      ytPlayerRef.current?.pauseVideo();
    } catch {
      // The IFrame player may still be initialising.
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }, []);

  const applyPermit = useCallback((permit: PlayPermit) => {
    if (permit.used !== undefined) setPlaysUsed(permit.used);
    if (permit.limit !== undefined) setPlaysLimit(permit.limit);
    setPlayBlock(permit.allowed ? null : (permit.reason ?? null));
    const known = accessRef.current;
    if (known && permit.used !== undefined) {
      accessRef.current = {
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
          setPlaysUsed(typeof body?.playsUsed === 'number' ? body.playsUsed : null);
          setPlaysLimit(typeof body?.playsLimit === 'number' ? body.playsLimit : null);
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
  const showNowPlaying = useCallback((track: ActiveTrack | null) => {
    const session = mediaSessionOrNull();
    if (!session) return;
    if (!track) {
      nowPlayingRef.current = null;
      session.metadata = null;
      return;
    }
    const key = `${track.qualifiedId}|${track.title}|${track.artworkUrl ?? ''}`;
    if (nowPlayingRef.current === key) return;
    nowPlayingRef.current = key;
    try {
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artistName,
        album: track.sourceLabel,
        artwork: mediaArtwork(track.artworkUrl),
      });
    } catch {
      session.metadata = null;
    }
  }, []);

  // Increases on every play request; a slow lookup for an older request is ignored.
  const playRequestRef = useRef(0);
  // Imported songs not found on YouTube in a row (auto-skip stops after a full lap).
  const missStreakRef = useRef(0);
  // Set every render below (needs followingIndex/playQueueIndex, defined later).
  const skipMissingRef = useRef<() => void>(() => undefined);
  const playCurrentTrack = useCallback(
    async (requested: ActiveTrack) => {
      let track = requested;
      const request = ++playRequestRef.current;
      if ((track.playbackMode === 'song' || isYouTubeTrack(track)) && isPageHidden()) {
        // YouTube never starts while Solco is hidden (API terms): it waits for the listener.
        audioRef.current?.pause();
        deferredVideoRef.current = track.qualifiedId;
        setPlayBlock(null);
        setErrorMessage(YOUTUBE_HIDDEN_NOTICE);
        setStatus('paused');
        setSessionPlaybackState('paused');
        return;
      }
      deferredVideoRef.current = null;
      if (track.playbackMode === 'song') {
        audioRef.current?.pause();
        setErrorMessage(null);
        setPlayBlock(null);
        setStatus('loading');
        setElapsedSeconds(0);
        setDurationSeconds(track.durationSeconds ?? 0);
        const resolved = await resolveSongTrack(track);
        // The listener picked something else (or closed the player) while we were searching.
        if (request !== playRequestRef.current) return;
        if (!resolved.ok) {
          setStatus('error');
          setErrorMessage(resolved.message);
          // Not on YouTube: move on to the next song instead of stopping the playlist. Quota
          // or network problems do not skip (the next song would fail the same way).
          if (resolved.notFound) skipMissingRef.current();
          return;
        }
        missStreakRef.current = 0;
        // Swap the song for its video in the queue: previous/next keep working.
        const songId = track.qualifiedId;
        setQueue((items) =>
          items.map((item) => (item.qualifiedId === songId ? resolved.track : item)),
        );
        setCurrentTrack(resolved.track);
        track = resolved.track;
      }
      if (isYouTubeTrack(track)) {
        audioRef.current?.pause();
        // The 'playback' audio session is for Solco's own audio, never for YouTube.
        releasePlaybackSession();
        setErrorMessage(null);
        setPlayBlock(null);
        setStatus('loading');
        setElapsedSeconds(0);
        setDurationSeconds(track.durationSeconds ?? 0);
        const permit = await requestPlayPermit(track.qualifiedId);
        if (request !== playRequestRef.current) return;
        applyPermit(permit);
        if (!permit.allowed) {
          try {
            ytPlayerRef.current?.pauseVideo();
          } catch {
            // Player not ready.
          }
          setStatus('idle');
          return;
        }
        // The engine effect loads the video once the visible dock is mounted.
        setYtRequest((value) => value + 1);
        return;
      }
      const audio = audioRef.current;
      if (!audio) return;
      setPreviewEnded(false);
      setPlayBlock(null);
      setErrorMessage(null);
      setStatus('loading');
      setElapsedSeconds(0);
      setDurationSeconds(isLiveTrack(track) ? 0 : (track.durationSeconds ?? 0));
      mediaRetryRef.current = 0;
      restartListeningSample(listeningRef.current);
      audio.pause();
      audio.preload = 'none';
      try {
        // Check Audius's stream authorization before requesting audio bytes.
        // Open streams start synchronously inside the tap: iOS Safari blocks play() after an await.
        // The permit request runs alongside: open streams must start inside the tap (iOS).
        const permitRequest = requestPlayPermit(track.qualifiedId);
        if (!isOpenStream(track)) {
          const early = await permitRequest;
          if (request !== playRequestRef.current) return;
          applyPermit(early);
          if (!early.allowed) {
            releaseAudio();
            setStatus('idle');
            return;
          }
          await verifyPlayback(track);
          if (request !== playRequestRef.current) return;
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
          return;
        }
        applyPermit(permit);
        if (!permit.allowed) {
          playing.catch(() => undefined);
          releaseAudio();
          setStatus('idle');
          return;
        }
        await playing;
        if (request !== playRequestRef.current) return;
        setStatus('playing');
      } catch (error) {
        // A newer request owns the audio element now: leave it alone.
        if (request !== playRequestRef.current) return;
        releaseAudio();
        setStatus('error');
        setErrorMessage(failureMessage(error, track));
      }
    },
    [applyPermit, releaseAudio, showNowPlaying],
  );

  const playTrack = useCallback(
    async (
      track: MusicPlayerTrack,
      streamPath: string,
      nextQueue: MusicPlayerTrack[] = [track],
    ) => {
      const safePath = safeStreamPath(streamPath, track);
      if (!safePath || !trackStreamPath(track)) {
        releaseAudio();
        setStatus('error');
        setErrorMessage('Il brano non ha un percorso Audius verificabile.');
        return;
      }
      const candidateQueue = nextQueue
        .map((item) => {
          const itemPath = trackStreamPath(item);
          return itemPath ? { ...item, streamPath: itemPath } : null;
        })
        .filter((item): item is ActiveTrack => item !== null);
      const selectedTrack = { ...track, streamPath: safePath };
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
      setQueue(candidateQueue);
      setQueueIndex(actualIndex);
      setCurrentTrack(selectedTrack);
      await playCurrentTrack(selectedTrack);
    },
    [playCurrentTrack, releaseAudio],
  );

  const playQueueIndex = useCallback(
    async (index: number) => {
      const next = queue[index];
      if (!next) return;
      releaseAudio();
      recordedRef.current = null;
      setQueueIndex(index);
      setCurrentTrack(next);
      await playCurrentTrack(next);
    },
    [playCurrentTrack, queue, releaseAudio],
  );

  // The next item is chosen once per current item (shuffle included), so what was prepared ahead
  // is what plays. While Solco is hidden, YouTube items are skipped when an audio item follows.
  const followingIndex = useCallback(
    (wrap: boolean) => {
      if (queue.length === 0 || queueIndex < 0) return null;
      const key = `${queueIndex}|${queue[queueIndex]?.qualifiedId ?? ''}|${queue.length}|${shuffle}|${wrap}`;
      const hidden = isPageHidden();
      const plan = nextPlanRef.current;
      if (
        plan &&
        plan.key === key &&
        (plan.index === null || !hidden || playsWhileHidden(queue[plan.index]?.playbackMode))
      ) {
        return plan.index;
      }
      const index = pickNextIndex({
        modes: queue.map((item) => item.playbackMode),
        index: queueIndex,
        shuffle,
        wrap,
        hidden,
      });
      nextPlanRef.current = { key, index };
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
    resume: () => Promise<void> | undefined;
  }>({ status: 'idle', pause: () => undefined, resume: () => undefined });

  const previousTrack = useCallback(async () => {
    const yt = ytPlayerRef.current;
    if (isYouTubeTrack(currentTrack) && yt && yt.getCurrentTime() > 5) {
      yt.seekTo(0, true);
      setElapsedSeconds(0);
      return;
    }
    const audio = audioRef.current;
    if (audio && !isLiveTrack(currentTrack) && audio.currentTime > 5) {
      audio.currentTime = 0;
      setElapsedSeconds(0);
      return;
    }
    if (queueIndex > 0 && !advanceRef.current(queueIndex - 1)) {
      await playQueueIndex(queueIndex - 1);
    }
  }, [currentTrack, playQueueIndex, queueIndex]);

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
      const audio = audioRef.current;
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
    [currentTrack],
  );

  const stopPlayback = useCallback(() => {
    // Cancel any lookup, permit or radio reconnect still pending: closing must not bring it back.
    playRequestRef.current += 1;
    clearTimer(reconnectTimerRef);
    missStreakRef.current = 0;
    releaseAudio();
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
  }, [releaseAudio, showNowPlaying]);

  // First statement of a tap that will start audio after a network wait (see MusicPlayerValue).
  // Only unlocks the element: the 'playback' session is declared right before play(), so a search
  // that finds nothing leaves it untouched while the YouTube video goes on.
  const primeAudio = useCallback(() => {
    primeMediaElement(audioRef.current);
  }, []);

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
      return;
    }
    // Paused while the next item was starting: cancel that start, do not restart it.
    if (status === 'loading') playRequestRef.current += 1;
    clearTimer(reconnectTimerRef);
    audioRef.current?.pause();
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
    declarePlaybackSession();
    setErrorMessage(null);
    audio.play().then(
      () => {
        if (request === playRequestRef.current) setStatus('playing');
      },
      (error: unknown) => {
        if (request !== playRequestRef.current || isDomError(error, 'AbortError')) return;
        if (isDomError(error, 'NotAllowedError')) {
          setStatus('paused');
          return;
        }
        setStatus('error');
        setErrorMessage(failureMessage(error, track));
        releaseAudio();
      },
    );
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
  const resumePlayback = (): Promise<void> | undefined => {
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
    const audio = audioRef.current;
    if (!audio) return undefined;
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

  // About 20 s before the end: freeze the next item and check it with requests that never
  // consume a Free play (rights: GET …/playback; quota: GET /api/music/access); warm its artwork.
  const prepareNext = () => {
    if (!currentTrack) return;
    const index = followingIndex(repeat === 'all');
    const next = index === null ? undefined : queue[index];
    if (index === null || !next) return;
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
      if (preparedRef.current === entry) entry.rights = verdict;
    });
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.currentTime > 2) reconnectsRef.current = 0;
    if (mediaRetryRef.current > 0 && audio.currentTime > retryPositionRef.current + 30) {
      mediaRetryRef.current = 0;
    }
    setElapsedSeconds(audio.currentTime);
    if (!isLiveTrack(currentTrack) && Number.isFinite(audio.duration))
      setDurationSeconds(audio.duration);
    if (
      currentTrack &&
      recordedRef.current !== currentTrack.qualifiedId &&
      audio.currentTime >= HISTORY_THRESHOLD_SECONDS
    ) {
      recordedRef.current = currentTrack.qualifiedId;
      recordPlay(currentTrack);
    }
    // Listening time for rewards (invites and "ascolta e guadagna"), from the seconds actually
    // played. YouTube videos never earn rewards: YouTube's policies forbid rewarding viewing.
    if (signedIn && currentTrack && !isYouTubeTrack(currentTrack) && !audio.paused) {
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

  /** Same element, same event: new src + play() with no network wait before it. */
  const startSynchronously = (index: number, next: ActiveTrack, audio: HTMLAudioElement) => {
    const request = ++playRequestRef.current;
    try {
      ytPlayerRef.current?.pauseVideo();
    } catch {
      // The IFrame player may still be initialising.
    }
    recordedRef.current = null;
    mediaRetryRef.current = 0;
    reconnectsRef.current = 0;
    pendingSeekRef.current = null;
    // The stream request itself counts the play on the server: refresh the counter once it plays.
    refreshOnPlayingRef.current = true;
    restartListeningSample(listeningRef.current);
    declarePlaybackSession();
    audio.src = next.streamPath;
    audio.load();
    const playing = audio.play();
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
        // iOS refused a start without a tap (page already suspended): wait for the listener, and
        // show the lock screen / notification as paused too (it was set to 'playing' above).
        if (isDomError(error, 'NotAllowedError')) {
          setStatus('paused');
          setSessionPlaybackState('paused');
        }
        // Other failures arrive through the element's 'error' event (handleError).
      },
    );
  };

  /**
   * Starts queue item `index` synchronously when that is safe: an audio item whose rights were
   * verified ahead (Audius/Solco) or an open stream (Jamendo, podcast, radio), with no Free-plan
   * block predicted. iOS suspends a locked page soon after its audio stops, so a network wait
   * here would stop the queue until the phone is unlocked. Returns false when the normal path
   * (with its network checks) has to run instead.
   */
  const advanceTo = (index: number): boolean => {
    const next = queue[index];
    const audio = audioRef.current;
    if (!next || !audio) return false;
    const prepared = preparedRef.current;
    preparedRef.current = null;
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
    startSynchronously(index, next, audio);
    return true;
  };
  advanceRef.current = advanceTo;

  const handleEnded = () => {
    const audio = audioRef.current;
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
    releaseAudio();
    setStatus('ended');
  };

  /** Restart the same stream on the same element, inside the error event (no timer needed). */
  const restartStream = (track: ActiveTrack, audio: HTMLAudioElement, position: number | null) => {
    const request = ++playRequestRef.current;
    pendingSeekRef.current = position !== null && position > 1 ? position : null;
    declarePlaybackSession();
    audio.src = track.streamPath;
    audio.load();
    audio.play().then(
      () => {
        if (request === playRequestRef.current) setStatus('playing');
      },
      (error: unknown) => {
        if (request !== playRequestRef.current) return;
        // iOS refused play() in a suspended page: no 'error' event follows, so stop 'loading'
        // (it disables the play buttons) and wait for the listener.
        if (isDomError(error, 'NotAllowedError')) {
          setStatus('paused');
          setSessionPlaybackState('paused');
        }
        // A network failure arrives as another 'error' event.
      },
    );
  };

  /** A stream failed: GET /api/music/access (never consumes a play) tells if the Free limit is why. */
  const explainStreamFailure = (track: ActiveTrack) => {
    const request = playRequestRef.current;
    const replay = isReplay(startedAtRef.current, track.qualifiedId, Date.now());
    void loadAccess().then((access) => {
      if (request !== playRequestRef.current) return;
      const block = predictPlayBlock(access, { qualifiedId: track.qualifiedId, replay });
      if (!block) return;
      setErrorMessage(null);
      setPlayBlock(block);
      setStatus('idle');
    });
  };

  const handleError = () => {
    const audio = audioRef.current;
    if (!currentTrack || !audio) return;
    if (previewEnded) return;
    // An error of a released element (no source) belongs to a playback already stopped.
    if (!audio.getAttribute('src')) return;
    const track = currentTrack;
    if (isLiveTrack(track) && reconnectsRef.current < MAX_RECONNECTS) {
      // Live radio drops on network changes (Wi-Fi ↔ mobile). The first reconnect runs right here,
      // on the same element: timers do not fire in a suspended (locked) iOS page.
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
            if (request === playRequestRef.current) void playCurrentTrack(track);
          },
          1000 * 2 ** (attempt - 1),
        );
      }
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
    setStatus('error');
    setErrorMessage(
      isOpenStream(track)
        ? failureMessage(null, track)
        : track.playbackMode === 'jamendo'
          ? 'Lo stream Jamendo si è interrotto. Riprova.'
          : 'Lo stream Audius è terminato con un errore. L’audio è stato fermato.',
    );
    releaseAudio();
    explainStreamFailure(track);
  };

  /** Keeps the system scrubber in step with the element (the OS extrapolates between updates). */
  const syncPositionState = () => {
    const session = mediaSessionOrNull();
    const audio = audioRef.current;
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
        const audio = audioRef.current;
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
    setStatus('playing');
    setBuffering(false);
    setSessionPlaybackState('playing');
    syncPositionState();
    // WebKit drops handlers registered before the page became "Now Playing": set them again.
    registerSystemControls();
    // The stream delivered audio, so the server allowed (and counted) it: replay window starts.
    if (currentTrack) rememberStart(startedAtRef.current, currentTrack.qualifiedId, Date.now());
    if (refreshOnPlayingRef.current) {
      refreshOnPlayingRef.current = false;
      void loadAccess();
    }
  };

  const handlePause = () => {
    const audio = audioRef.current;
    restartListeningSample(listeningRef.current);
    setBuffering(false);
    // The 'pause' fired at the end of an item: 'ended' moves on, Now Playing stays "playing".
    if (!audio || audio.ended) return;
    // Also follows pauses decided by the system: calls, Siri, headphones unplugged.
    setStatus((current) => (current === 'playing' ? 'paused' : current));
    if (audio.getAttribute('src')) syncPositionState();
  };

  const hidePlayer = pathname === '/admin' || pathname.startsWith('/admin/');
  const showFull = expanded && Boolean(currentTrack) && !hidePlayer;
  // Keep the YouTube dock (and its player) mounted while an imported song is being looked up,
  // so the player is reused instead of being torn down and rebuilt for every song.
  const youtubeActive =
    (isYouTubeTrack(currentTrack) || currentTrack?.playbackMode === 'song') && !hidePlayer;
  // Same song in the listener's Spotify app or on soundcloud.com: plain search links (no Spotify
  // or SoundCloud API and no embedded player involved).
  const songSearch = (() => {
    if (!currentTrack || isLiveTrack(currentTrack) || currentTrack.playbackMode === 'podcast') {
      return null;
    }
    const song =
      isYouTubeTrack(currentTrack) && !currentTrack.importedFrom
        ? parseVideoTitle(currentTrack.title, currentTrack.artistName)
        : { title: currentTrack.title, artist: currentTrack.artistName };
    const title = song.title.replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').trim();
    return title ? { title, artist: song.artist || null } : null;
  })();
  const spotifyLink = songSearch ? spotifySearchUrl(songSearch.title, songSearch.artist) : null;
  const soundcloudLink = songSearch
    ? soundcloudSearchUrl(songSearch.title, songSearch.artist)
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
  // Video found hidden: never audible in the background (YouTube API terms), whatever started it.
  const deferHiddenVideo = (qualifiedId: string) => {
    deferredVideoRef.current = qualifiedId;
    setStatus('paused');
    setErrorMessage(YOUTUBE_HIDDEN_NOTICE);
    setSessionPlaybackState('paused');
  };
  ytEvents.current = {
    onPlaying: () => {
      if (isPageHidden()) {
        try {
          ytPlayerRef.current?.pauseVideo();
        } catch {
          // Player not ready.
        }
        // It was playing and stopped only because Solco is hidden: explain it on return.
        ytPlayingRef.current = false;
        markHiddenPause(currentVideoId);
        setStatus('paused');
        setSessionPlaybackState('paused');
        return;
      }
      // The video plays again (player controls or the notice): the notice has done its job.
      dismissReturnNotice();
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
    onEnded: handleEnded,
    onError: (code) => {
      // A video chosen for an imported song does not play: forget that choice for everyone.
      const failedVideo = currentTrack ? youtubeVideoId(currentTrack) : null;
      if (currentTrack?.importedFrom && failedVideo) {
        void fetch('/api/music/resolve-song', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: currentTrack.title,
            artist: currentTrack.artistName || undefined,
            videoId: failedVideo,
          }),
        }).catch(() => undefined);
      }
      // 101/150: the uploader blocked embedding; 100: removed; 2/5: invalid or HTML5 error.
      setErrorMessage(
        code === 101 || code === 150
          ? 'Questo video non può essere riprodotto fuori da YouTube. Passo al successivo.'
          : 'Il video non è disponibile. Passo al successivo.',
      );
      const index = followingIndex(repeat === 'all');
      if (index !== null && index !== queueIndex) void playQueueIndex(index);
      else setStatus('error');
    },
    onProgress: (elapsed, duration) => {
      setElapsedSeconds(elapsed);
      if (duration > 0) setDurationSeconds(duration);
      if (currentTrack) recordProgress(currentTrack, elapsed);
    },
  };

  // YouTube engine: create the official player inside the visible dock, then reuse it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ytRequest is an explicit (re)load trigger.
  useEffect(() => {
    if (!youtubeActive || !currentTrack) return;
    const videoId = youtubeVideoId(currentTrack);
    const host = ytHostRef.current;
    if (!videoId || !host) return;
    // A new video has not played yet: a hide before it starts is not a "video fermato".
    ytPlayingRef.current = false;
    // Loading a video starts it: never in a hidden page. It starts when Solco is visible again.
    if (isPageHidden()) {
      deferHiddenVideo(currentTrack.qualifiedId);
      return;
    }
    if (ytPlayerRef.current) {
      ytPlayerRef.current.loadVideoById(videoId);
      return;
    }
    let cancelled = false;
    const qualifiedId = currentTrack.qualifiedId;
    loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled || !ytHostRef.current) return;
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
            onStateChange: (event: { data: number }) => {
              // Paused, ended, unstarted (new video) or cued: not playing. Buffering keeps the
              // previous value: a re-buffer mid-song (or after a seek) is still playing.
              if (event.data === YT_PLAYING) ytPlayingRef.current = true;
              else if (event.data !== YT_BUFFERING) ytPlayingRef.current = false;
              if (event.data === YT_PLAYING) ytEvents.current.onPlaying();
              else if (event.data === YT_PAUSED) ytEvents.current.onPaused();
              else if (event.data === YT_ENDED) ytEvents.current.onEnded();
              else if (event.data === YT_BUFFERING) setStatus('loading');
            },
            onError: (event: { data: number }) => ytEvents.current.onError(event.data),
          },
        });
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

  useEffect(() => {
    document.body.classList.toggle('music-player-expanded', showFull);
    if (!showFull) return () => document.body.classList.remove('music-player-expanded');
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
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

  // Network back after a drop: resume live radio automatically.
  useEffect(() => {
    const resume = () => {
      if (currentTrack && isLiveTrack(currentTrack) && status === 'error' && !previewEnded) {
        reconnectsRef.current = 0;
        void playCurrentTrack(currentTrack);
      }
    };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, [currentTrack, playCurrentTrack, previewEnded, status]);

  // Restore the last queue (paused) after a reload or when reopening the app.
  useEffect(() => {
    if (restoredRef.current || process.env.NODE_ENV === 'test') return;
    restoredRef.current = true;
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as {
        queue?: MusicPlayerTrack[];
        index?: number;
        position?: number;
      } | null;
      if (!saved?.queue?.length || typeof saved.index !== 'number') return;
      const restored = saved.queue
        .map((item) => {
          const path = trackStreamPath(item);
          return path ? { ...item, streamPath: path } : null;
        })
        .filter((item): item is ActiveTrack => item !== null);
      const track = restored[saved.index];
      if (!track) return;
      setQueue(restored);
      setQueueIndex(saved.index);
      setCurrentTrack(track);
      setStatus('idle');
      if (!isLiveTrack(track) && typeof saved.position === 'number' && saved.position > 5) {
        pendingSeekRef.current = saved.position;
        setElapsedSeconds(saved.position);
      }
    } catch {
      // Corrupt or unavailable storage: start empty.
    }
  }, []);

  // Save queue and position (throttled to whole seconds).
  const savedSecond = Math.floor(elapsedSeconds / 5);
  // biome-ignore lint/correctness/useExhaustiveDependencies: saves every 5 s of progress, not every tick.
  useEffect(() => {
    if (!restoredRef.current || !currentTrack || queueIndex < 0) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          queue: queue.slice(0, 100).map(({ streamPath: _path, ...item }) => item),
          index: queueIndex,
          position: isLiveTrack(currentTrack) ? 0 : elapsedSeconds,
        }),
      );
    } catch {
      // Quota or private mode: persistence is best-effort.
    }
  }, [currentTrack, queue, queueIndex, savedSecond]);

  // Navigating to another page collapses the full-screen player.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to route changes only.
  useEffect(() => {
    setExpanded(false);
  }, [pathname]);

  // Now Playing metadata, once per item (iOS lock screen and Control Center, Android notification).
  useEffect(() => {
    showNowPlaying(currentTrack);
    // A new item starts without a scrubber until its own metadata loads (see syncPositionState).
    applyPositionState(mediaSessionOrNull(), null);
    if (!currentTrack) setSessionPlaybackState('none');
  }, [currentTrack, showNowPlaying]);

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

  // Unmounted: no handler or pending reconnect may point at a dead player.
  useEffect(
    () => () => {
      clearTimer(reconnectTimerRef);
      const session = mediaSessionOrNull();
      if (!session) return;
      for (const action of MEDIA_SESSION_ACTIONS) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Unsupported action; there is no handler to remove.
        }
      }
    },
    [],
  );

  // A stopped, failed or blocked item shows as paused (play retries it); 'none' only when closed.
  useEffect(() => {
    if (currentTrack && (status === 'error' || status === 'idle' || status === 'ended')) {
      setSessionPlaybackState('paused');
    }
  }, [currentTrack, status]);

  // Repeat one: the element loops by itself and never reaches 'ended' (no gap, no new request).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.loop =
      repeat === 'one' &&
      Boolean(currentTrack) &&
      !isLiveTrack(currentTrack) &&
      !isYouTubeTrack(currentTrack);
  }, [currentTrack, repeat]);

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
    if (play && !play.disabled) return play;
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
  const showCounter =
    playsLimit !== null && playsUsed !== null && showsFreePlayCounter(currentTrack?.playbackMode);

  const progress =
    !live && durationSeconds > 0 ? Math.min(100, (elapsedSeconds / durationSeconds) * 100) : 0;
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

  return (
    <MusicPlayerContext.Provider
      value={{
        currentTrack,
        status,
        elapsedSeconds,
        durationSeconds,
        queue,
        queueIndex,
        errorMessage,
        shuffle,
        repeat,
        expanded,
        premium,
        previewEnded,
        playBlock,
        playsUsed,
        playsLimit,
        playTrack,
        togglePlayback,
        previousTrack,
        nextTrack,
        seekTo,
        stopPlayback,
        toggleShuffle,
        cycleRepeat,
        setExpanded,
        primeAudio,
      }}
    >
      {children}
      <audio
        ref={audioRef}
        hidden
        preload="none"
        aria-hidden="true"
        tabIndex={-1}
        // Status follows the element: 'playing' only once audio really flows, not on play().
        onPlaying={handlePlaying}
        onPause={handlePause}
        onWaiting={() => setBuffering(true)}
        onSeeking={() => restartListeningSample(listeningRef.current)}
        onSeeked={syncPositionState}
        onRateChange={syncPositionState}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={() => {
          handleTimeUpdate();
          syncPositionState();
        }}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (audio && pendingSeekRef.current !== null && Number.isFinite(audio.duration)) {
            audio.currentTime = Math.min(pendingSeekRef.current, audio.duration);
            pendingSeekRef.current = null;
          }
          handleTimeUpdate();
          syncPositionState();
        }}
        onEnded={handleEnded}
        onError={handleError}
      >
        <track kind="captions" src="/music-captions.vtt" srcLang="it" label="Musica" />
      </audio>
      {currentTrack && !hidePlayer ? (
        <>
          {youtubeActive ? (
            <div
              className={`${styles.videoDock} ${showFull ? styles.videoDockExpanded : ''}`}
              data-youtube-official-frame
            >
              {showFull ? null : (
                <div className={styles.videoBar}>
                  <span>{currentTrack.title}</span>
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
            data-solco-player
          >
            <button
              ref={miniExpandRef}
              type="button"
              className={styles.miniExpand}
              onClick={() => setExpanded(true)}
              aria-label={`Apri il player: ${currentTrack.title}`}
              aria-expanded={showFull}
            >
              <span className={styles.miniArt} aria-hidden="true">
                <Artwork track={currentTrack} size={44} />
              </span>
              <span className={styles.miniCopy}>
                <strong>{currentTrack.title}</strong>
                <span>
                  {live ? <em className={styles.liveBadge}>LIVE</em> : null}
                  {currentTrack.artistName} · {currentTrack.sourceLabel}
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
                onClick={() => void togglePlayback()}
                disabled={status === 'loading'}
                aria-label={playLabel}
              >
                {status === 'playing' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
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
                    Per ascoltare serve un account gratuito. <a href="/signup">Registrati</a> o{' '}
                    <a href="/login">accedi</a>.
                  </>
                ) : (
                  <>
                    Hai usato i {playsLimit ?? 40} ascolti gratuiti di questo mese.{' '}
                    <a href="/piani">Passa a Premium per ascolti illimitati</a>.
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
            <span className={styles.miniProgress} aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </span>
          </aside>

          <section
            className={`${styles.full} ${youtubeActive ? styles.fullVideo : ''}`}
            aria-label="Player a schermo intero"
            data-solco-player
            hidden={!showFull}
            inert={!showFull}
          >
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
                  <Artwork track={currentTrack} size={480} />
                </div>
              )}

              <div className={styles.trackCopy}>
                {showFull ? returnNoticeFor('full') : null}
                <strong title={currentTrack.title}>{currentTrack.title}</strong>
                <span className={styles.trackMeta}>
                  {live ? <em className={styles.liveBadge}>LIVE</em> : null}
                  {currentTrack.artistName} · {currentTrack.sourceLabel}
                </span>
                {showCounter && playsLimit !== null && playsUsed !== null ? (
                  <p className={styles.adNote}>
                    Ascolti gratuiti questo mese: {Math.min(playsUsed, playsLimit)} di {playsLimit}.{' '}
                    <a href="/piani">Illimitati con Premium</a>
                  </p>
                ) : null}
                {backgroundVideo ? (
                  <BackgroundListenButton
                    compact={false}
                    video={backgroundVideo}
                    hint="continua con lo schermo bloccato"
                  />
                ) : null}
                {youtubeActive ? (
                  <p className={styles.adNote}>
                    Eventuali annunci nei video sono di YouTube: Solco non li controlla. Con YouTube
                    Premium, se hai effettuato l’accesso a YouTube in questo browser, non li vedi.
                  </p>
                ) : null}
                <span className={styles.links}>
                  {spotifyLink ? (
                    <a href={spotifyLink} target="_blank" rel="noreferrer">
                      Apri in Spotify <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
                  {soundcloudLink ? (
                    <a href={soundcloudLink} target="_blank" rel="noreferrer">
                      Cerca su SoundCloud <ExternalLink aria-hidden="true" />
                    </a>
                  ) : null}
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
                <input
                  className={styles.seek}
                  type="range"
                  min={0}
                  max={durationSeconds || 0}
                  step={1}
                  value={Math.min(elapsedSeconds, durationSeconds || 0)}
                  onChange={(event) => seekTo(Number(event.target.value))}
                  disabled={live || durationSeconds <= 0 || status === 'loading'}
                  aria-label={
                    live ? 'Diretta radio: avanzamento non disponibile' : 'Avanzamento brano Audius'
                  }
                />
                <span className={styles.time}>
                  <span>{formattedTime(elapsedSeconds)}</span>
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
                  <button
                    className={styles.skip}
                    type="button"
                    onClick={() => void previousTrack()}
                    disabled={queueIndex <= 0 && (live || elapsedSeconds <= 5)}
                    aria-label="Brano precedente"
                  >
                    <SkipBack aria-hidden="true" />
                  </button>
                  <button
                    ref={fullPlayRef}
                    className={styles.control}
                    type="button"
                    onClick={() => void togglePlayback()}
                    disabled={status === 'loading'}
                    aria-label={playLabel}
                  >
                    {status === 'playing' ? (
                      <Pause aria-hidden="true" />
                    ) : (
                      <Play aria-hidden="true" />
                    )}
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
                </div>
              </div>

              <details className={styles.queue} open>
                <summary>
                  <ListMusic aria-hidden="true" /> Coda · {queue.length} brani
                </summary>
                <ol>
                  {queue.map((item, index) => (
                    <li key={`${index}-${item.qualifiedId}`}>
                      <div className={styles.queueItem}>
                        <span className={styles.queueArtwork}>
                          {item.artworkUrl ? (
                            <Image
                              src={item.artworkUrl}
                              alt=""
                              width={36}
                              height={36}
                              unoptimized
                            />
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
                  ))}
                </ol>
              </details>
            </div>
          </section>
        </>
      ) : null}
    </MusicPlayerContext.Provider>
  );
}
