// @polsia:user-owned — avviso al ritorno su Solco: un video YouTube che suonava si è fermato
// perché la pagina o l'app è stata nascosta (le norme YouTube vietano l'ascolto in background).
// Al ritorno si propone, una sola volta per video, di continuare lo stesso brano su Audius.
// Il passaggio avviene solo con un tocco dell'utente, mai in automatico.

/** At most this many videos are remembered as "notice already shown" per page session. */
const SHOWN_LIMIT = 200;

export type ReturnNoticeTracker = {
  /** Video paused by the player because the page was hidden while it played. */
  pending: string | null;
  /** Videos whose notice was already shown: never again for them. */
  shown: Set<string>;
};

export function createReturnNoticeTracker(): ReturnNoticeTracker {
  return { pending: null, shown: new Set() };
}

/** The player paused `videoId` because the page became hidden while it was playing. */
export function noteHiddenPause(tracker: ReturnNoticeTracker, videoId: string | null | undefined) {
  if (!videoId || tracker.shown.has(videoId)) return;
  tracker.pending = videoId;
}

/**
 * Page visible again: the video to show the notice for, or null. Only the video that was paused
 * by the hidden page, only while it is still the current item, and only once per video.
 */
export function takeReturnNotice(
  tracker: ReturnNoticeTracker,
  currentVideoId: string | null | undefined,
): string | null {
  const pending = tracker.pending;
  tracker.pending = null;
  if (!pending || pending !== currentVideoId || tracker.shown.has(pending)) return null;
  tracker.shown.add(pending);
  if (tracker.shown.size > SHOWN_LIMIT) {
    const oldest = tracker.shown.values().next().value;
    if (oldest !== undefined) tracker.shown.delete(oldest);
  }
  return pending;
}

/** Public watch page of a video (the id is validated: 11 URL-safe characters). */
export function youtubeWatchUrl(videoId: string) {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId)
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : 'https://www.youtube.com/';
}
