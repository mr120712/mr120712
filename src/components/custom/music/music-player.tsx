// @polsia:user-owned — player unico condiviso tra le pagine musicali.
'use client';

import {
  ExternalLink,
  ListMusic,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
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
  playbackMode?: 'audius' | 'solco';
  credits?: string[];
};

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
};

const MusicPlayerContext = createContext<MusicPlayerValue | null>(null);

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

function trackStreamPath(track: MusicPlayerTrack) {
  const match = /^audius:([A-Za-z0-9_-]{1,128})$/.exec(track.qualifiedId);
  if (!match?.[1]) return null;
  if (track.playbackMode === 'audius') {
    return `/api/music/audius/tracks/${encodeURIComponent(match[1])}/stream`;
  }
  if (
    track.playbackMode !== 'solco' ||
    !track.albumId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(track.albumId)
  )
    return null;
  return `/api/music/albums/${encodeURIComponent(track.albumId)}/tracks/${encodeURIComponent(match[1])}/stream`;
}

function playbackPath(track: MusicPlayerTrack) {
  const match = /^audius:([A-Za-z0-9_-]{1,128})$/.exec(track.qualifiedId);
  if (!match?.[1]) return null;
  if (track.playbackMode === 'audius') {
    return `/api/music/audius/tracks/${encodeURIComponent(match[1])}/playback`;
  }
  if (
    track.playbackMode !== 'solco' ||
    !track.albumId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(track.albumId)
  )
    return null;
  return `/api/music/albums/${encodeURIComponent(track.albumId)}/tracks/${encodeURIComponent(match[1])}/playback`;
}

function formattedTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function failureMessage(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; reason?: unknown; retryAfterSeconds?: unknown })
      : null;
  const reason = typeof cause?.reason === 'string' ? cause.reason : null;
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

export function useMusicPlayer() {
  const player = useContext(MusicPlayerContext);
  if (!player) throw new Error('useMusicPlayer deve essere usato dentro MusicPlayerProvider.');
  return player;
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTrack, setCurrentTrack] = useState<ActiveTrack | null>(null);
  const [queue, setQueue] = useState<ActiveTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }, []);

  const playCurrentTrack = useCallback(
    async (track: ActiveTrack) => {
      const audio = audioRef.current;
      if (!audio) return;
      setErrorMessage(null);
      setStatus('loading');
      setElapsedSeconds(0);
      setDurationSeconds(track.durationSeconds ?? 0);
      audio.pause();
      audio.preload = 'none';
      try {
        const path = playbackPath(track);
        if (!path) throw new Error('Track is not an authorized album item');
        const verdict = await apiFetch(path, { schema: AudiusPlaybackCheckSchema });
        if (!verdict.allowed) throw new Error(verdict.reason);
        // Check Audius's stream authorization before requesting audio bytes.
        audio.src = track.streamPath;
        audio.load();
        await audio.play();
        setStatus('playing');
      } catch (error) {
        releaseAudio();
        setStatus('error');
        setErrorMessage(failureMessage(error));
      }
    },
    [releaseAudio],
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
      setQueueIndex(index);
      setCurrentTrack(next);
      await playCurrentTrack(next);
    },
    [playCurrentTrack, queue, releaseAudio],
  );

  const previousTrack = useCallback(async () => {
    if (queueIndex > 0) await playQueueIndex(queueIndex - 1);
  }, [playQueueIndex, queueIndex]);

  const nextTrack = useCallback(async () => {
    if (queueIndex >= 0 && queueIndex < queue.length - 1) await playQueueIndex(queueIndex + 1);
  }, [playQueueIndex, queue.length, queueIndex]);

  const togglePlayback = useCallback(async () => {
    if (!currentTrack) return;
    if (status === 'playing') {
      audioRef.current?.pause();
      setStatus('paused');
      return;
    }
    if (status === 'paused') {
      try {
        const path = playbackPath(currentTrack);
        if (!path) throw new Error('Track is not an authorized album item');
        const verdict = await apiFetch(path, { schema: AudiusPlaybackCheckSchema });
        if (!verdict.allowed) throw new Error(verdict.reason);
        await audioRef.current?.play();
        setStatus('playing');
        setErrorMessage(null);
      } catch (error) {
        setStatus('error');
        setErrorMessage(failureMessage(error));
        releaseAudio();
      }
      return;
    }
    await playCurrentTrack(currentTrack);
  }, [currentTrack, playCurrentTrack, releaseAudio, status]);

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(audio.duration))
      return;
    audio.currentTime = Math.min(seconds, audio.duration);
    setElapsedSeconds(audio.currentTime);
  }, []);

  const stopPlayback = useCallback(() => {
    releaseAudio();
    setCurrentTrack(null);
    setQueue([]);
    setQueueIndex(-1);
    setStatus('idle');
    setElapsedSeconds(0);
    setDurationSeconds(0);
    setErrorMessage(null);
  }, [releaseAudio]);

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setElapsedSeconds(audio.currentTime);
    if (Number.isFinite(audio.duration)) setDurationSeconds(audio.duration);
  };

  const handleEnded = () => {
    if (queueIndex >= 0 && queueIndex < queue.length - 1) {
      void nextTrack();
      return;
    }
    releaseAudio();
    setStatus('ended');
  };

  const handleError = () => {
    if (!currentTrack) return;
    setStatus('error');
    setErrorMessage('Lo stream Audius è terminato con un errore. L’audio è stato fermato.');
    releaseAudio();
  };

  const hidePlayer = pathname === '/admin' || pathname.startsWith('/admin/');

  useEffect(() => {
    document.body.classList.toggle('has-music-player', Boolean(currentTrack) && !hidePlayer);
    if (hidePlayer && currentTrack) stopPlayback();
    return () => document.body.classList.remove('has-music-player');
  }, [currentTrack, hidePlayer, stopPlayback]);

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
          ? [{ src: currentTrack.artworkUrl, sizes: '512x512' }]
          : [],
      });
    } catch {
      mediaSession.metadata = null;
    }
    mediaSession.playbackState =
      status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => void togglePlayback()],
      ['pause', () => void togglePlayback()],
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
  }, [currentTrack, elapsedSeconds, nextTrack, previousTrack, seekTo, status, togglePlayback]);

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
        playTrack,
        togglePlayback,
        previousTrack,
        nextTrack,
        seekTo,
        stopPlayback,
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
        onLoadedMetadata={handleTimeUpdate}
        onEnded={handleEnded}
        onError={handleError}
      >
        <track kind="captions" src="/music-captions.vtt" srcLang="it" label="Musica" />
      </audio>
      {currentTrack && !hidePlayer ? (
        <aside className={styles.dock} aria-label="Player musicale Solco">
          <div className={styles.dockInner}>
            <span className={styles.disc} aria-hidden="true">
              {currentTrack.artworkUrl ? (
                <Image src={currentTrack.artworkUrl} alt="" width={44} height={44} unoptimized />
              ) : (
                <Music2 />
              )}
            </span>
            <div className={styles.trackCopy}>
              <span className={styles.playerLabel}>
                ORA IN ASCOLTO · {currentTrack.sourceLabel}
              </span>
              <strong title={currentTrack.title}>{currentTrack.title}</strong>
              <span className={styles.trackMeta}>
                {currentTrack.artistName} · {currentTrack.sourceLabel}
              </span>
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
              {errorMessage ? (
                <output className={styles.playerError} aria-live="polite">
                  {errorMessage}
                </output>
              ) : null}
              <details className={styles.queue}>
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
            <div className={styles.playerControls}>
              <span className={styles.time}>
                {formattedTime(elapsedSeconds)} /{' '}
                {durationSeconds ? formattedTime(durationSeconds) : '--:--'}
              </span>
              <input
                className={styles.seek}
                type="range"
                min={0}
                max={durationSeconds || 0}
                step={1}
                value={Math.min(elapsedSeconds, durationSeconds || 0)}
                onChange={(event) => seekTo(Number(event.target.value))}
                disabled={durationSeconds <= 0 || status === 'loading'}
                aria-label="Avanzamento brano Audius"
              />
              <div className={styles.buttons}>
                <button
                  className={styles.skip}
                  type="button"
                  onClick={() => void previousTrack()}
                  disabled={queueIndex <= 0}
                  aria-label="Brano precedente"
                >
                  <SkipBack />
                </button>
                <button
                  className={styles.control}
                  type="button"
                  onClick={() => void togglePlayback()}
                  disabled={status === 'loading'}
                  aria-label={
                    status === 'playing'
                      ? `Metti in pausa ${currentTrack.title}`
                      : `Riproduci ${currentTrack.title}`
                  }
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
                  disabled={queueIndex < 0 || queueIndex >= queue.length - 1}
                  aria-label="Brano successivo"
                >
                  <SkipForward />
                </button>
                <button
                  className={styles.stop}
                  type="button"
                  onClick={stopPlayback}
                  aria-label="Chiudi player"
                >
                  <Square aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </aside>
      ) : null}
    </MusicPlayerContext.Provider>
  );
}
