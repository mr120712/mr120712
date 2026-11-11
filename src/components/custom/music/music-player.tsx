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
import { AudiusPlaybackCheckSchema } from '@/lib/contracts/music';
import styles from './music-player.module.css';
import { loadYouTubeIframeApi } from './youtube-queue-player';

export type MusicPlaybackMode = 'audius' | 'solco' | 'radio' | 'podcast' | 'jamendo' | 'youtube';

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
  if (!verdict.allowed) throw new Error(verdict.reason);
}

function formattedTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function failureMessage(error: unknown, track: MusicPlayerTrack | null) {
  if (track?.playbackMode === 'radio')
    return 'La stazione radio non risponde in questo momento. Prova un’altra stazione.';
  if (track?.playbackMode === 'podcast')
    return 'L’episodio non è disponibile dal feed del podcast. Riprova più tardi.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; reason?: unknown; retryAfterSeconds?: unknown })
      : null;
  const reason = typeof cause?.reason === 'string' ? cause.reason : null;
  if (reason === 'premium_required')
    return 'Il catalogo globale Jamendo è incluso in Solco Premium. Scopri i piani in /piani.';
  if (track?.playbackMode === 'jamendo' && reason === 'unauthorized')
    return 'Accedi con un account Premium per ascoltare il catalogo globale.';
  if (reason === 'unauthorized') return 'Accedi per verificare l’accesso a Solco Pro.';
  if (reason === 'pro_required')
    return 'L’ascolto integrale richiede un abbonamento Solco Pro attivo.';
  if (reason === 'rights_unverified' || reason === 'rights_unavailable')
    return 'Questo brano non è disponibile: fonte o diritti di streaming non sono verificati.';
  if (reason === 'entitlement_unavailable')
    return 'La verifica dell’abbonamento non è disponibile. Nessun audio è stato riprodotto.';
  if (reason === 'track_unavailable') return 'Il brano non è disponibile per l’ascolto integrale.';
  if (reason === 'catalog_unavailable')
    return 'Il catalogo Audius non è verificabile. Nessun audio è stato riprodotto.';
  if (reason === 'album_context_required')
    return 'Per l’ascolto integrale serve una scheda album verificata.';
  if (reason === 'source_inactive')
    return 'Audius non è configurata o non è disponibile. Nessun audio è stato riprodotto.';
  if (reason === 'track_not_found') return 'Audius non ha trovato il brano richiesto.';
  if (reason === 'not_streamable') return 'Audius non autorizza lo streaming di questo brano.';
  if (reason === 'gated' || reason === 'access_denied')
    return 'Audius non autorizza questo stream per l’accesso corrente.';
  if (reason === 'access_unknown' || reason === 'state_unknown')
    return 'Audius non ha confermato lo stato di accesso; la riproduzione è stata fermata.';
  if (reason === 'rate_limited')
    return typeof cause?.retryAfterSeconds === 'number'
      ? `Audius ha limitato le richieste. Riprova tra ${cause.retryAfterSeconds} secondi.`
      : 'Audius ha limitato le richieste; attendi prima di riprovare.';
  return 'La verifica o lo stream Audius è fallito. Nessun audio è stato lasciato in riproduzione.';
}

export type PlayBlock = 'login_required' | 'monthly_limit';

type PlayPermit = { allowed: boolean; reason?: PlayBlock; used?: number; limit?: number | null };

/** Chiede al server il permesso di avviare un brano (limite di 40 ascolti al mese per i free). */
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
  const [ytRequest, setYtRequest] = useState(0);
  const [premium, setPremium] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [playBlock, setPlayBlock] = useState<PlayBlock | null>(null);
  const [playsUsed, setPlaysUsed] = useState<number | null>(null);
  const [playsLimit, setPlaysLimit] = useState<number | null>(null);
  const [previewEnded, setPreviewEnded] = useState(false);
  const reconnectsRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(null);
  const restoredRef = useRef(false);
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
  }, []);

  const playCurrentTrack = useCallback(
    async (track: ActiveTrack) => {
      if (isYouTubeTrack(track)) {
        audioRef.current?.pause();
        setErrorMessage(null);
        setPlayBlock(null);
        setStatus('loading');
        setElapsedSeconds(0);
        setDurationSeconds(track.durationSeconds ?? 0);
        const permit = await requestPlayPermit(track.qualifiedId);
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
      audio.pause();
      audio.preload = 'none';
      try {
        // Check Audius's stream authorization before requesting audio bytes.
        // Open streams start synchronously inside the tap: iOS Safari blocks play() after an await.
        // The permit request runs alongside: open streams must start inside the tap (iOS).
        const permitRequest = requestPlayPermit(track.qualifiedId);
        if (!isOpenStream(track)) {
          const early = await permitRequest;
          applyPermit(early);
          if (!early.allowed) {
            releaseAudio();
            setStatus('idle');
            return;
          }
          await verifyPlayback(track);
        }
        audio.src = track.streamPath;
        audio.load();
        const playing = audio.play();
        const permit = await permitRequest;
        applyPermit(permit);
        if (!permit.allowed) {
          playing.catch(() => undefined);
          releaseAudio();
          setStatus('idle');
          return;
        }
        await playing;
        setStatus('playing');
      } catch (error) {
        releaseAudio();
        setStatus('error');
        setErrorMessage(failureMessage(error, track));
      }
    },
    [applyPermit, releaseAudio],
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

  const followingIndex = useCallback(
    (wrap: boolean) => {
      if (queue.length === 0 || queueIndex < 0) return null;
      if (shuffle && queue.length > 1) {
        const offset = 1 + Math.floor(Math.random() * (queue.length - 1));
        return (queueIndex + offset) % queue.length;
      }
      if (queueIndex < queue.length - 1) return queueIndex + 1;
      return wrap ? 0 : null;
    },
    [queue.length, queueIndex, shuffle],
  );

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
    if (queueIndex > 0) await playQueueIndex(queueIndex - 1);
  }, [currentTrack, playQueueIndex, queueIndex]);

  const nextTrack = useCallback(async () => {
    const index = followingIndex(repeat === 'all');
    if (index !== null) await playQueueIndex(index);
  }, [followingIndex, playQueueIndex, repeat]);

  const togglePlayback = useCallback(async () => {
    if (!currentTrack) return;
    if (isYouTubeTrack(currentTrack) && ytPlayerRef.current) {
      if (status === 'playing') ytPlayerRef.current.pauseVideo();
      else ytPlayerRef.current.playVideo();
      return;
    }
    if (status === 'playing') {
      audioRef.current?.pause();
      setStatus('paused');
      return;
    }
    if (status === 'paused') {
      if (previewEnded) {
        await playCurrentTrack(currentTrack);
        return;
      }
      if (isLiveTrack(currentTrack)) {
        // A paused live stream would resume from stale buffered audio: reconnect instead.
        await playCurrentTrack(currentTrack);
        return;
      }
      try {
        await verifyPlayback(currentTrack);
        await audioRef.current?.play();
        setStatus('playing');
        setErrorMessage(null);
      } catch (error) {
        setStatus('error');
        setErrorMessage(failureMessage(error, currentTrack));
        releaseAudio();
      }
      return;
    }
    await playCurrentTrack(currentTrack);
  }, [currentTrack, playCurrentTrack, previewEnded, releaseAudio, status]);

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
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode): nothing to clear.
    }
  }, [releaseAudio]);

  const toggleShuffle = useCallback(() => setShuffle((value) => !value), []);
  const cycleRepeat = useCallback(
    () => setRepeat((value) => (value === 'off' ? 'all' : value === 'all' ? 'one' : 'off')),
    [],
  );

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.currentTime > 2) reconnectsRef.current = 0;
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
  };

  const handleEnded = () => {
    const audio = audioRef.current;
    if (repeat === 'one' && isYouTubeTrack(currentTrack) && ytPlayerRef.current) {
      ytPlayerRef.current.seekTo(0, true);
      ytPlayerRef.current.playVideo();
      return;
    }
    if (repeat === 'one' && audio && currentTrack) {
      audio.currentTime = 0;
      void audio.play();
      return;
    }
    const index = followingIndex(repeat === 'all');
    if (index !== null) {
      void playQueueIndex(index);
      return;
    }
    releaseAudio();
    setStatus('ended');
  };

  const handleError = () => {
    if (!currentTrack) return;
    if (previewEnded) return;
    if (isLiveTrack(currentTrack) && reconnectsRef.current < MAX_RECONNECTS) {
      // Live radio drops on network changes (Wi-Fi ↔ mobile): reconnect with backoff.
      const attempt = reconnectsRef.current;
      reconnectsRef.current += 1;
      const track = currentTrack;
      setStatus('loading');
      window.setTimeout(() => void playCurrentTrack(track), 1000 * 2 ** attempt);
      return;
    }
    setStatus('error');
    setErrorMessage(
      isOpenStream(currentTrack)
        ? failureMessage(null, currentTrack)
        : currentTrack.playbackMode === 'jamendo'
          ? 'Lo stream Jamendo si è interrotto. Riprova.'
          : 'Lo stream Audius è terminato con un errore. L’audio è stato fermato.',
    );
    releaseAudio();
  };

  const hidePlayer = pathname === '/admin' || pathname.startsWith('/admin/');
  const showFull = expanded && Boolean(currentTrack) && !hidePlayer;
  const youtubeActive = isYouTubeTrack(currentTrack) && !hidePlayer;

  const recordProgress = (track: MusicPlayerTrack, seconds: number) => {
    if (recordedRef.current !== track.qualifiedId && seconds >= HISTORY_THRESHOLD_SECONDS) {
      recordedRef.current = track.qualifiedId;
      recordPlay(track);
    }
  };

  // Latest handlers for the YouTube engine callbacks (created once per player instance).
  ytEvents.current = {
    onPlaying: () => {
      setStatus('playing');
      setErrorMessage(null);
    },
    onPaused: () =>
      setStatus((value) => (value === 'playing' || value === 'loading' ? 'paused' : value)),
    onEnded: handleEnded,
    onError: (code) => {
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
    if (ytPlayerRef.current) {
      ytPlayerRef.current.loadVideoById(videoId);
      return;
    }
    let cancelled = false;
    loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled || !ytHostRef.current) return;
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

  // YouTube's terms: no background playback. Pause when Solco is hidden.
  useEffect(() => {
    if (!youtubeActive) return;
    const pauseHidden = () => {
      if (document.visibilityState !== 'visible') ytPlayerRef.current?.pauseVideo();
    };
    document.addEventListener('visibilitychange', pauseHidden);
    return () => document.removeEventListener('visibilitychange', pauseHidden);
  }, [youtubeActive]);

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

  // Premium check: full and background listening vs 30-second previews.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch('/api/music/access', { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then(
          (
            body: {
              premium?: unknown;
              signedIn?: unknown;
              playsUsed?: unknown;
              playsLimit?: unknown;
            } | null,
          ) => {
            if (cancelled) return;
            setPremium(body?.premium === true);
            setSignedIn(body?.signedIn === true);
            setPlaysUsed(typeof body?.playsUsed === 'number' ? body.playsUsed : null);
            setPlaysLimit(typeof body?.playsLimit === 'number' ? body.playsLimit : null);
          },
        )
        .catch(() => {
          if (!cancelled) setPremium(false);
        });
    };
    check();
    // Re-check when the listener comes back (e.g. after subscribing in another tab).
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, []);

  // Listening time for rewards (invites and "ascolta e guadagna"): one tick per minute played.
  useEffect(() => {
    if (!signedIn || status !== 'playing') return;
    const timer = window.setInterval(() => {
      fetch('/api/rewards', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'listen', seconds: 60 }),
      }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [signedIn, status]);

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

  // Lock-screen / notification scrubber (Android, iOS 15+).
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    try {
      if (isLiveTrack(currentTrack) || !durationSeconds || durationSeconds < elapsedSeconds) {
        navigator.mediaSession.setPositionState?.();
      } else {
        navigator.mediaSession.setPositionState?.({
          duration: durationSeconds,
          position: Math.min(elapsedSeconds, durationSeconds),
          playbackRate: 1,
        });
      }
    } catch {
      // Older browsers: no position state.
    }
  }, [currentTrack, durationSeconds, elapsedSeconds]);

  // Navigating to another page collapses the full-screen player.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to route changes only.
  useEffect(() => {
    setExpanded(false);
  }, [pathname]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const mediaSession = navigator.mediaSession;
    if (!currentTrack) {
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
      return;
    }

    try {
      mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artistName,
        album: currentTrack.sourceLabel,
        artwork: currentTrack.artworkUrl
          ? ['96x96', '192x192', '512x512'].map((sizes) => ({
              src: currentTrack.artworkUrl as string,
              sizes,
            }))
          : [{ src: '/solco-android-icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
      });
    } catch {
      mediaSession.metadata = null;
    }
    mediaSession.playbackState =
      status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => void togglePlayback()],
      ['pause', () => void togglePlayback()],
      ['stop', () => stopPlayback()],
      ['previoustrack', () => void previousTrack()],
      ['nexttrack', () => void nextTrack()],
      [
        'seekbackward',
        (details) => seekTo(Math.max(0, elapsedSeconds - (details.seekOffset ?? 10))),
      ],
      ['seekforward', (details) => seekTo(elapsedSeconds + (details.seekOffset ?? 10))],
      [
        'seekto',
        (details) => {
          if (details.seekTime !== undefined) seekTo(details.seekTime);
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Browsers expose different supported Media Session actions.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // Unsupported action; there is no handler to remove.
        }
      }
    };
  }, [
    currentTrack,
    elapsedSeconds,
    nextTrack,
    previousTrack,
    seekTo,
    status,
    stopPlayback,
    togglePlayback,
  ]);

  const live = isLiveTrack(currentTrack);
  const hasNext =
    queueIndex >= 0 &&
    (queueIndex < queue.length - 1 || ((repeat === 'all' || shuffle) && queue.length > 1));
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
      }}
    >
      {children}
      <audio
        ref={audioRef}
        hidden
        preload="none"
        aria-hidden="true"
        tabIndex={-1}
        onPlay={() => setStatus('playing')}
        onPause={() => setStatus((current) => (current === 'playing' ? 'paused' : current))}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleTimeUpdate}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (audio && pendingSeekRef.current !== null && Number.isFinite(audio.duration)) {
            audio.currentTime = Math.min(pendingSeekRef.current, audio.duration);
            pendingSeekRef.current = null;
          }
          handleTimeUpdate();
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
            </div>
          ) : null}
          <aside className={styles.mini} aria-label="Player musicale Solco" data-solco-player>
            <button
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
              <button
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
                <strong title={currentTrack.title}>{currentTrack.title}</strong>
                <span className={styles.trackMeta}>
                  {live ? <em className={styles.liveBadge}>LIVE</em> : null}
                  {currentTrack.artistName} · {currentTrack.sourceLabel}
                </span>
                {playsLimit !== null && playsUsed !== null ? (
                  <p className={styles.adNote}>
                    Ascolti gratuiti questo mese: {Math.min(playsUsed, playsLimit)} di {playsLimit}.{' '}
                    <a href="/piani">Illimitati con Premium</a>
                  </p>
                ) : null}
                {youtubeActive ? (
                  <p className={styles.adNote}>
                    Eventuali annunci nei video sono di YouTube: Solco non li controlla. Con YouTube
                    Premium, se hai effettuato l’accesso a YouTube in questo browser, non li vedi.
                  </p>
                ) : null}
                <span className={styles.links}>
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
                    <li key={item.qualifiedId}>
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
