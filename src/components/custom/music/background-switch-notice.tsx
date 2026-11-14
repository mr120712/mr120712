// @polsia:user-owned — avviso al ritorno su Solco: il video YouTube si è fermato perché l'app è
// stata nascosta (YouTube non consente l'ascolto in background). Propone, solo con un tocco, di
// continuare lo stesso brano su Audius con il flusso di "Ascolta in background", oppure di
// riprendere il video. Non è una finestra modale e non sposta il focus quando compare.
'use client';

import { ExternalLink, Headphones, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createReturnNoticeTracker,
  noteHiddenPause,
  takeReturnNotice,
  youtubeWatchUrl,
} from '@/lib/music/background-switch';
import { type BackgroundVideo, useBackgroundListen } from './background-listen-button';
import styles from './background-switch-notice.module.css';

export const RETURN_NOTICE_TEXT =
  'Il video si è fermato perché sei uscito dall’app. YouTube non permette l’ascolto in background.';
export const RETURN_NOTICE_MISSING_TEXT =
  'Questo brano non è su Audius: puoi riprendere il video o aprirlo su YouTube.';
export const RETURN_NOTICE_ERROR_TEXT = 'Non riesco a cercare su Audius adesso. Riprova tra poco.';

/** How long the spoken text stays in the live region (browse mode would read it twice). */
const ANNOUNCEMENT_MS = 7000;

// One polite live region for every notice, created when a player mounts, long before a notice
// appears: a live region inserted together with its text is not announced by many screen readers
// (VoiceOver on iOS in particular). It lives outside React, so placement changes never remount it.
let liveRegion: HTMLElement | null = null;
let announcementTimer: number | undefined;

function ensureLiveRegion() {
  if (liveRegion?.isConnected) return { region: liveRegion, created: false };
  const region = document.createElement('div');
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.className = styles.srOnly ?? '';
  region.dataset.backgroundSwitchAnnouncer = '';
  document.body.append(region);
  liveRegion = region;
  return { region, created: true };
}

/** Speaks `text` once through the shared live region ('' clears it). */
export function announceReturnNotice(text: string) {
  const { region, created } = ensureLiveRegion();
  window.clearTimeout(announcementTimer);
  region.textContent = '';
  if (!text) return;
  const fill = () => {
    region.textContent = text;
    announcementTimer = window.setTimeout(() => {
      region.textContent = '';
    }, ANNOUNCEMENT_MS);
  };
  // Just inserted: give assistive technology a moment to register the region first.
  if (created) announcementTimer = window.setTimeout(fill, 100);
  else fill();
}

/**
 * Remembers a YouTube video paused because the page became hidden while it played, and returns
 * the video to show the notice for once the page is visible again (at most once per video).
 */
export function useReturnNotice(currentVideoId: string | null) {
  const trackerRef = useRef(createReturnNoticeTracker());
  const currentRef = useRef(currentVideoId);
  currentRef.current = currentVideoId;
  const [noticeVideoId, setNoticeVideoId] = useState<string | null>(null);

  useEffect(() => {
    // The live region exists before any notice, so its first text is announced.
    ensureLiveRegion();
    const showOnReturn = () => {
      if (document.visibilityState !== 'visible') return;
      const videoId = takeReturnNotice(trackerRef.current, currentRef.current);
      if (videoId) setNoticeVideoId(videoId);
    };
    document.addEventListener('visibilitychange', showOnReturn);
    // Back from the back/forward cache after a pagehide.
    window.addEventListener('pageshow', showOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', showOnReturn);
      window.removeEventListener('pageshow', showOnReturn);
    };
  }, []);

  // The notice belongs to one video: another item (or the Audius switch) removes it.
  useEffect(() => {
    setNoticeVideoId((value) => (value !== null && value !== currentVideoId ? null : value));
  }, [currentVideoId]);

  /** Call from the player's own hidden-page pause, only when the video was playing. */
  const markHiddenPause = useCallback((videoId: string | null) => {
    noteHiddenPause(trackerRef.current, videoId);
  }, []);
  const dismiss = useCallback(() => setNoticeVideoId(null), []);

  return {
    noticeVideoId:
      noticeVideoId !== null && noticeVideoId === currentVideoId ? noticeVideoId : null,
    markHiddenPause,
    dismiss,
  };
}

export function BackgroundSwitchNotice({
  video,
  onResume,
  onDismiss,
  focusTarget,
  className,
}: {
  video: BackgroundVideo;
  /** "Riprendi il video": runs inside the tap (the official player resumes the video). */
  onResume: () => void;
  onDismiss: () => void;
  /**
   * A stable control outside the notice (e.g. the play/pause button): it receives the focus when
   * the notice closes while the focus is inside it, instead of falling back to the page top.
   */
  focusTarget?: () => HTMLElement | null | undefined;
  className?: string;
}) {
  const { available, searching, start } = useBackgroundListen(video);
  // 'missing': every search answered without this song; 'error': a search failed (retry).
  const [result, setResult] = useState<'idle' | 'missing' | 'error'>('idle');
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  // This notice already waits for an outcome (its own search or one it joined).
  const waitingRef = useRef(false);
  const focusTargetRef = useRef(focusTarget);
  focusTargetRef.current = focusTarget;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const missing = result === 'missing';
  const message =
    result === 'missing'
      ? RETURN_NOTICE_MISSING_TEXT
      : result === 'error'
        ? RETURN_NOTICE_ERROR_TEXT
        : RETURN_NOTICE_TEXT;

  // Spoken when the notice appears and when its text changes; silent again once it closes.
  useEffect(() => {
    announceReturnNotice(message);
    return () => announceReturnNotice('');
  }, [message]);

  /** Closes the notice; a focus inside it moves to the player's stable control. */
  const close = () => {
    const root = rootRef.current;
    const hadFocus = Boolean(
      root && document.activeElement && root.contains(document.activeElement),
    );
    onDismiss();
    if (!hadFocus) return;
    const target = focusTargetRef.current?.();
    if (target && !root?.contains(target)) target.focus();
  };

  const continueInBackground = () => {
    // A second tap changes nothing. A search started by "Ascolta in background" for the same
    // video is joined, not ignored: start() returns it, so this notice still closes on success.
    if (waitingRef.current) return;
    waitingRef.current = true;
    // Synchronous, inside the tap: start() unlocks the audio element before any network wait.
    start()
      .then(
        (outcome) => {
          if (!mountedRef.current) return;
          // Playing the audio version, or the video is no longer current: the notice is done.
          if (outcome.status === 'playing' || outcome.status === 'stale') {
            close();
            return;
          }
          if (outcome.status === 'error') {
            // The search did not answer: keep the button, the listener can try again.
            setResult('error');
            return;
          }
          // The primary button goes away: keep the keyboard focus inside the notice.
          const hadFocus = document.activeElement === primaryRef.current;
          setResult('missing');
          if (hadFocus) window.setTimeout(() => resumeRef.current?.focus(), 0);
        },
        () => undefined,
      )
      .finally(() => {
        waitingRef.current = false;
      });
  };

  return (
    <div
      ref={rootRef}
      className={`${styles.notice} ${className ?? ''}`}
      data-background-switch-notice
    >
      <Headphones aria-hidden="true" className={styles.noticeIcon} />
      {/* Announced through the shared live region (see announceReturnNotice). */}
      <p className={styles.noticeText} data-notice-text>
        {message}
      </p>
      <button
        type="button"
        className={styles.dismiss}
        onClick={close}
        aria-label="Chiudi l’avviso sul video in pausa"
      >
        <X aria-hidden="true" />
      </button>
      <div className={styles.actions}>
        {!missing && available ? (
          <button
            ref={primaryRef}
            type="button"
            className={styles.primary}
            onClick={continueInBackground}
            aria-disabled={searching || undefined}
          >
            {searching ? (
              <Loader2 aria-hidden="true" className={styles.spin} />
            ) : (
              <Headphones aria-hidden="true" />
            )}
            {/* Narrow video dock: .longLabel words are hidden visually, never from the name. */}
            {searching ? (
              <span>Cerco su Audius…</span>
            ) : (
              <span>
                Continua <span className={styles.longLabel}>in background </span>con Audius
              </span>
            )}
          </button>
        ) : null}
        <button
          ref={resumeRef}
          type="button"
          className={styles.secondary}
          onClick={() => {
            onResume();
            close();
          }}
        >
          <span>
            Riprendi<span className={styles.longLabel}> il video</span>
          </span>
        </button>
        {missing ? (
          <a
            className={styles.link}
            href={youtubeWatchUrl(video.videoId)}
            target="_blank"
            rel="noreferrer"
          >
            Apri su YouTube <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </div>
  );
}
