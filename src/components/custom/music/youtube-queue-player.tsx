// @polsia:user-owned — coda di riproduzione YouTube basata sulla IFrame Player API ufficiale.
// Il player resta sempre visibile con controlli, marchio e annunci gestiti da YouTube:
// Solco aggiunge solo la coda (precedente / successivo / avanzamento automatico), il pulsante
// "Ascolta in background" (stesso brano su Audius, solo con un tocco) e l'avviso al ritorno.
'use client';

import { ExternalLink, SkipBack, SkipForward, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { BackgroundListenButton } from './background-listen-button';
import { BackgroundSwitchNotice, useReturnNotice } from './background-switch-notice';
import styles from './music.module.css';
import { useOptionalMusicPlayer } from './music-player';

export type YouTubeQueueItem = {
  videoId: string;
  title: string;
  channelTitle: string;
};

type YouTubePlayerInstance = {
  loadVideoById: (videoId: string) => void;
  playVideo?: () => void;
  pauseVideo: () => void;
  destroy: () => void;
};

type YouTubePlayerEvent = { data: number };

type YouTubeNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      host: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (event: YouTubePlayerEvent) => void;
        onError: (event: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayerInstance;
};

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
const YOUTUBE_STATE_ENDED = 0;
const YOUTUBE_STATE_PLAYING = 1;
const YOUTUBE_STATE_PAUSED = 2;

let apiPromise: Promise<YouTubeNamespace> | null = null;

/** Carica una sola volta lo script ufficiale della IFrame Player API. */
export function loadYouTubeIframeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YouTube IFrame API non disponibile.'));
    };
    const script = document.createElement('script');
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('Script YouTube IFrame API non caricato.'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function YouTubeQueuePlayer({
  items,
  index,
  onIndexChange,
  onClose,
  onPlaying,
  pauseRequested = false,
}: {
  items: YouTubeQueueItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Chiamato quando YouTube avvia la riproduzione (per fermare l’audio Solco). */
  onPlaying?: () => void;
  /** Quando diventa true il video viene messo in pausa (es. parte un brano Solco). */
  pauseRequested?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Takes the focus when the "video fermato" notice closes with the focus inside it.
  const sectionRef = useRef<HTMLElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const readyRef = useRef(false);
  // The video is playing (YouTube state 1) and not yet paused or ended.
  const playingRef = useRef(false);
  // The shared Solco player, needed by "Ascolta in background" (absent when rendered alone).
  const musicPlayer = useOptionalMusicPlayer();
  const loadedVideoIdRef = useRef<string | null>(null);
  const latest = useRef({ items, index, onIndexChange, onPlaying });
  latest.current = { items, index, onIndexChange, onPlaying };

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState<string | null>(null);

  const current = items[index];
  const currentVideoId = current?.videoId ?? null;
  const {
    noticeVideoId,
    markHiddenPause,
    dismiss: dismissReturnNotice,
  } = useReturnNotice(currentVideoId);
  const latestNotice = useRef({ markHiddenPause, dismissReturnNotice });
  latestNotice.current = { markHiddenPause, dismissReturnNotice };

  // Crea il player una sola volta; i cambi di brano passano da loadVideoById.
  useEffect(() => {
    const host = hostRef.current;
    const initialVideoId = latest.current.items[latest.current.index]?.videoId;
    if (!host || !initialVideoId) return;
    let cancelled = false;

    const advance = (reason: 'ended' | 'error') => {
      const state = latest.current;
      if (state.index < state.items.length - 1) {
        state.onIndexChange(state.index + 1);
        return;
      }
      setNotice(
        reason === 'ended'
          ? 'Coda YouTube terminata.'
          : 'L’ultimo video della coda non può essere riprodotto fuori da YouTube.',
      );
    };

    loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled) return;
        const mount = document.createElement('div');
        host.replaceChildren(mount);
        loadedVideoIdRef.current = initialVideoId;
        playerRef.current = new api.Player(mount, {
          videoId: initialVideoId,
          width: '100%',
          height: '100%',
          host: 'https://www.youtube.com',
          playerVars: {
            controls: 1,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              readyRef.current = true;
              setStatus('ready');
              const wanted = latest.current.items[latest.current.index]?.videoId;
              if (wanted && wanted !== loadedVideoIdRef.current) {
                loadedVideoIdRef.current = wanted;
                playingRef.current = false;
                playerRef.current?.loadVideoById(wanted);
              }
            },
            onStateChange: (event) => {
              if (cancelled) return;
              if (event.data === YOUTUBE_STATE_PLAYING) {
                playingRef.current = true;
                setNotice(null);
                // Playing again: the "video fermato" notice has done its job.
                latestNotice.current.dismissReturnNotice();
                latest.current.onPlaying?.();
              } else if (event.data === YOUTUBE_STATE_PAUSED) {
                playingRef.current = false;
              } else if (event.data === YOUTUBE_STATE_ENDED) {
                playingRef.current = false;
                advance('ended');
              }
            },
            onError: () => {
              if (cancelled) return;
              const failed = latest.current.items[latest.current.index];
              setNotice(
                `“${failed?.title ?? 'Questo video'}” non è riproducibile nel player incorporato. Passo al successivo.`,
              );
              advance('error');
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      readyRef.current = false;
      playingRef.current = false;
      try {
        playerRef.current?.destroy();
      } catch {
        // Il player può essere già stato rimosso dal DOM.
      }
      playerRef.current = null;
      loadedVideoIdRef.current = null;
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (!currentVideoId || !readyRef.current) return;
    if (loadedVideoIdRef.current === currentVideoId) return;
    loadedVideoIdRef.current = currentVideoId;
    // The next video has not played yet: hiding Solco before it starts is no "video fermato".
    playingRef.current = false;
    playerRef.current?.loadVideoById(currentVideoId);
  }, [currentVideoId]);

  // Nessuna riproduzione in background: pausa quando Solco non è visibile. Un video che stava
  // suonando riceve, al ritorno, l'avviso con l'alternativa Audius (mai un passaggio automatico).
  useEffect(() => {
    const noteIfPlaying = () => {
      if (!playingRef.current) return;
      latestNotice.current.markHiddenPause(
        latest.current.items[latest.current.index]?.videoId ?? null,
      );
    };
    const pauseWhenHidden = () => {
      if (document.visibilityState !== 'visible' && readyRef.current) {
        noteIfPlaying();
        playerRef.current?.pauseVideo();
      }
    };
    const pauseOnPageHide = () => {
      if (!readyRef.current) return;
      noteIfPlaying();
      playerRef.current?.pauseVideo();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    window.addEventListener('pagehide', pauseOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      window.removeEventListener('pagehide', pauseOnPageHide);
    };
  }, []);

  useEffect(() => {
    if (pauseRequested && readyRef.current) playerRef.current?.pauseVideo();
  }, [pauseRequested]);

  if (!current) return null;

  return (
    <section
      ref={sectionRef}
      className={styles.youtubeQueue}
      aria-label="Coda di riproduzione YouTube"
      tabIndex={-1}
    >
      <header className={styles.youtubeQueueHeader}>
        <div>
          <span className={`${styles.sourcePill} ${styles.youtubePill}`}>
            Coda YouTube · {index + 1} di {items.length}
          </span>
          <h3>{current.title}</h3>
          <p className={styles.artistLine}>{current.channelTitle}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <X aria-hidden="true" />
          Chiudi player
        </Button>
      </header>

      <div className={styles.youtubeFrame} data-youtube-official-frame>
        <div ref={hostRef} className={styles.youtubeQueueHost} />
      </div>

      {/* Below the official player, never over it (YouTube forbids overlays). */}
      {musicPlayer && noticeVideoId === current.videoId ? (
        <BackgroundSwitchNotice
          key={current.videoId}
          video={current}
          onResume={() => {
            try {
              playerRef.current?.playVideo?.();
            } catch {
              // Player not ready: the listener can use the video's own controls.
            }
          }}
          onDismiss={dismissReturnNotice}
          focusTarget={() => sectionRef.current}
        />
      ) : null}

      {status === 'loading' ? (
        <output className={styles.youtubeQueueNotice}>Carico il player ufficiale YouTube…</output>
      ) : null}
      {status === 'error' ? (
        <output className={styles.youtubeQueueNotice}>
          Il player YouTube non è stato caricato. Controlla la connessione e riapri il video.
        </output>
      ) : null}
      {notice ? (
        <output className={styles.youtubeQueueNotice} aria-live="polite">
          {notice}
        </output>
      ) : null}

      {musicPlayer ? (
        <BackgroundListenButton
          compact={false}
          video={current}
          hint="continua con lo schermo bloccato"
        />
      ) : null}

      <div className={styles.youtubeQueueControls}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index <= 0}
          onClick={() => onIndexChange(index - 1)}
        >
          <SkipBack aria-hidden="true" />
          Precedente
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index >= items.length - 1}
          onClick={() => onIndexChange(index + 1)}
        >
          Successivo
          <SkipForward aria-hidden="true" />
        </Button>
        <a
          href={`https://www.youtube.com/watch?v=${encodeURIComponent(current.videoId)}`}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" />
          Apri su YouTube
        </a>
      </div>

      <ol className={styles.youtubeQueueList}>
        {items.map((item, itemIndex) => (
          <li key={item.videoId}>
            <button
              type="button"
              aria-current={itemIndex === index ? 'true' : undefined}
              onClick={() => onIndexChange(itemIndex)}
            >
              <span>{itemIndex + 1}</span>
              <strong>{item.title}</strong>
              <em>{item.channelTitle}</em>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
