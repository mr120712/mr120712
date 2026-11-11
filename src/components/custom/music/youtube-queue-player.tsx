// @polsia:user-owned — coda di riproduzione YouTube basata sulla IFrame Player API ufficiale.
// Il player resta sempre visibile con controlli, marchio e annunci gestiti da YouTube:
// Solco aggiunge solo la coda (precedente / successivo / avanzamento automatico), il pulsante
// "Ascolta in background" (stesso brano su Audius, solo con un tocco) e l'avviso al ritorno.
// La coda viene passata al player ufficiale come playlist (cuePlaylist / loadPlaylist, al massimo
// 50 video, vedi youtube-runs.ts): è YouTube a preparare e avviare il video successivo, e Solco
// segue l'indice che YouTube riporta. Nessun video viene scaricato o messo in cache.
'use client';

import { ExternalLink, SkipBack, SkipForward, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  continuesInRun,
  type PendingRunMove,
  predatesMove,
  type RunQueueItem,
  readPlayerReport,
  reportedRunPosition,
  runHoldsIndex,
  runMoveCommand,
  type YouTubeRun,
  youtubeRunAt,
} from '@/lib/music/youtube-runs';
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
  cueVideoById?: (videoId: string) => void;
  playVideo?: () => void;
  pauseVideo: () => void;
  destroy: () => void;
  // Playlist API, present once the official player is ready: YouTube prepares the next video.
  loadPlaylist?: (playlist: string[], index?: number, startSeconds?: number) => void;
  cuePlaylist?: (playlist: string[], index?: number, startSeconds?: number) => void;
  nextVideo?: () => void;
  previousVideo?: () => void;
  playVideoAt?: (index: number) => void;
  getPlaylistIndex?: () => number;
  getVideoData?: () => { video_id?: string } | null | undefined;
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
const YOUTUBE_STATE_BUFFERING = 3;
const YOUTUBE_STATE_CUED = 5;

/** The queue as run items: every entry is a YouTube video. */
function asRunItems(items: YouTubeQueueItem[]): RunQueueItem[] {
  return items.map((item) => ({ qualifiedId: `youtube:${item.videoId}`, playbackMode: 'youtube' }));
}

function isPageHidden() {
  return document.visibilityState !== 'visible';
}

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
  // The queue as a playlist in the official player (null: a single video), the queue index the
  // player is on (or was sent to), and a move YouTube has not reported yet (see youtube-runs.ts).
  const runRef = useRef<YouTubeRun | null>(null);
  const positionRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingRunMove | null>(null);
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

  /**
   * Shows queue item `index` in the official player. Inside the playlist it holds: nextVideo(),
   * previousVideo() or playVideoAt(). Otherwise the queue window around it as a new playlist
   * (loadPlaylist, or cuePlaylist when it must not start: on ready, or with Solco hidden), or the
   * single video as before.
   */
  const show = (target: number, mode: 'play' | 'cue') => {
    const player = playerRef.current;
    const queue = latest.current.items;
    const item = queue[target];
    if (!player || !item) return;
    const runItems = asRunItems(queue);
    const run = runRef.current;
    const start = mode === 'play' && !isPageHidden();
    const from = positionRef.current;
    try {
      if (
        start &&
        runHoldsIndex(run, runItems, target) &&
        typeof player.playVideoAt === 'function'
      ) {
        const reported = reportedRunPosition(
          run,
          readPlayerReport(player),
          (from ?? target) - run.start,
        );
        const at =
          reported ??
          (from !== null && runHoldsIndex(run, runItems, from) ? from - run.start : null);
        const move = runMoveCommand(at, target - run.start);
        if (move.kind === 'next' && player.nextVideo) player.nextVideo();
        else if (move.kind === 'previous' && player.previousVideo) player.previousVideo();
        else player.playVideoAt(target - run.start);
        pendingRef.current = { index: target, from: at === null ? null : run.start + at };
      } else {
        const next = youtubeRunAt(runItems, target);
        if (
          next &&
          next.videoIds.length > 1 &&
          typeof player.loadPlaylist === 'function' &&
          typeof player.cuePlaylist === 'function'
        ) {
          if (start) player.loadPlaylist(next.videoIds, next.offset, 0);
          else player.cuePlaylist(next.videoIds, next.offset, 0);
          runRef.current = next;
          pendingRef.current = { index: target, from };
        } else if (!start) {
          // Must not start (hidden, or cue mode): cued, never loadVideoById (which starts it).
          // Without cueVideoById nothing is loaded; the next visible show() loads the item.
          if (typeof player.cueVideoById !== 'function') return;
          player.cueVideoById(item.videoId);
          runRef.current = null;
          pendingRef.current = null;
        } else {
          player.loadVideoById(item.videoId);
          runRef.current = null;
          pendingRef.current = null;
        }
      }
    } catch {
      // Player still starting: onReady shows the current item.
      return;
    }
    positionRef.current = target;
    loadedVideoIdRef.current = item.videoId;
    // The next video has not played yet: hiding Solco before it starts is no "video fermato".
    playingRef.current = false;
  };

  /**
   * YouTube moved along its playlist by itself (end of a video, or its own controls): the queue
   * follows that video without reloading it. Returns the new index, or null.
   */
  const follow = (): number | null => {
    const player = playerRef.current;
    const run = runRef.current;
    const runItems = asRunItems(latest.current.items);
    const current = positionRef.current ?? latest.current.index;
    if (!player || !runHoldsIndex(run, runItems, current)) return null;
    const position = reportedRunPosition(run, readPlayerReport(player), current - run.start);
    if (position === null) {
      // An unknown report never blocks the end of the video (see ENDED).
      pendingRef.current = null;
      return null;
    }
    const reported = run.start + position;
    // A report from before the move the listener asked for: its command is about to land.
    if (predatesMove(pendingRef.current, reported)) return null;
    pendingRef.current = null;
    if (reported === current) return null;
    positionRef.current = reported;
    loadedVideoIdRef.current = run.videoIds[position] ?? null;
    latest.current.onIndexChange(reported);
    return reported;
  };

  /** A video started (or is about to) while Solco is hidden: paused at once, explained on return. */
  const pauseHidden = (moved: number | null) => {
    playingRef.current = false;
    try {
      playerRef.current?.pauseVideo();
    } catch {
      // Player not ready.
    }
    const shown = moved ?? positionRef.current ?? latest.current.index;
    latestNotice.current.markHiddenPause(latest.current.items[shown]?.videoId ?? null);
  };

  const engine = useRef({ show, follow, pauseHidden });
  engine.current = { show, follow, pauseHidden };

  // Crea il player una sola volta; i cambi di brano passano dalla playlist di YouTube
  // (nextVideo / previousVideo / playVideoAt) o, fuori da essa, da loadPlaylist / loadVideoById.
  useEffect(() => {
    const host = hostRef.current;
    const initialVideoId = latest.current.items[latest.current.index]?.videoId;
    if (!host || !initialVideoId) return;
    let cancelled = false;

    const advance = (reason: 'ended' | 'error', from = latest.current.index) => {
      const state = latest.current;
      if (from < state.items.length - 1) {
        state.onIndexChange(from + 1);
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
        positionRef.current = latest.current.index;
        runRef.current = null;
        pendingRef.current = null;
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
              const { items: queue, index: wantedIndex } = latest.current;
              const wanted = queue[wantedIndex]?.videoId;
              if (!wanted) return;
              if (wanted !== loadedVideoIdRef.current) {
                engine.current.show(wantedIndex, 'play');
                return;
              }
              // Same video, still not started: hand YouTube the queue as a playlist (cued), so
              // the next video is prepared once the listener presses play.
              const run = youtubeRunAt(asRunItems(queue), wantedIndex);
              if (
                run &&
                run.videoIds.length > 1 &&
                typeof playerRef.current?.cuePlaylist === 'function'
              ) {
                engine.current.show(wantedIndex, 'cue');
              }
            },
            onStateChange: (event) => {
              if (cancelled) return;
              if (event.data === YOUTUBE_STATE_PLAYING) {
                const moved = engine.current.follow();
                if (isPageHidden()) {
                  // Never audible in the background, also a video YouTube advanced to by itself.
                  engine.current.pauseHidden(moved);
                  return;
                }
                playingRef.current = true;
                setNotice(null);
                // Playing again: the "video fermato" notice has done its job.
                latestNotice.current.dismissReturnNotice();
                latest.current.onPlaying?.();
              } else if (event.data === YOUTUBE_STATE_PAUSED) {
                playingRef.current = false;
              } else if (event.data === YOUTUBE_STATE_ENDED) {
                playingRef.current = false;
                const run = runRef.current;
                const at = positionRef.current ?? latest.current.index;
                if (runHoldsIndex(run, asRunItems(latest.current.items), at)) {
                  // The video left by a move the listener asked for: not this item's end.
                  if (pendingRef.current) return;
                  // YouTube starts the next video of its playlist by itself; followed on PLAYING.
                  if (continuesInRun(run, at)) return;
                }
                advance('ended', at);
              } else if (event.data === YOUTUBE_STATE_BUFFERING) {
                // Hidden: whatever video is loading is paused before it is ever heard (one YouTube
                // advances to by itself, or a move sent just before Solco was hidden).
                if (!isPageHidden()) return;
                const wasPlaying = playingRef.current;
                const moved = engine.current.follow();
                if (moved !== null || wasPlaying) {
                  engine.current.pauseHidden(moved);
                  return;
                }
                // Never played: paused, with no "video fermato" notice.
                playingRef.current = false;
                try {
                  playerRef.current?.pauseVideo();
                } catch {
                  // Player not ready.
                }
              } else if (event.data === YOUTUBE_STATE_CUED) {
                engine.current.follow();
              }
            },
            onError: () => {
              if (cancelled) return;
              // The failing video may be one YouTube moved to by itself inside its playlist.
              const moved = engine.current.follow();
              const failedIndex = moved ?? positionRef.current ?? latest.current.index;
              const failed = latest.current.items[failedIndex];
              setNotice(
                `“${failed?.title ?? 'Questo video'}” non è riproducibile nel player incorporato. Passo al successivo.`,
              );
              advance('error', failedIndex);
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
      runRef.current = null;
      positionRef.current = null;
      pendingRef.current = null;
      host.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (!currentVideoId || !readyRef.current) return;
    // Already there: YouTube moved along its playlist (followed) or this video is loaded.
    if (positionRef.current === index && loadedVideoIdRef.current === currentVideoId) return;
    engine.current.show(index, 'play');
  }, [currentVideoId, index]);

  // Nessuna riproduzione in background: pausa quando Solco non è visibile. Un video che stava
  // suonando riceve, al ritorno, l'avviso con l'alternativa Audius (mai un passaggio automatico).
  useEffect(() => {
    const noteIfPlaying = () => {
      if (!playingRef.current) return;
      latestNotice.current.markHiddenPause(
        latest.current.items[positionRef.current ?? latest.current.index]?.videoId ?? null,
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
