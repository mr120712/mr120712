// @polsia:user-owned — "YouTube playlist runs": consecutive YouTube videos of a queue handed to the
// official IFrame player as one playlist (player.loadPlaylist / cuePlaylist), so that YouTube itself
// prepares and starts the next video. Nothing is downloaded or cached by Solco: the videos only ever
// play inside the visible official player (YouTube API terms). Pure helpers, shared by the Solco
// player (music-player.tsx) and the search-page queue (youtube-queue-player.tsx).

/** Most videos handed to the official player in one playlist. */
export const YOUTUBE_RUN_LIMIT = 50;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const QUALIFIED_VIDEO = /^youtube:([A-Za-z0-9_-]{11})$/;

/** The part of a queue item a run needs. */
export type RunQueueItem = { qualifiedId: string; playbackMode?: string | null };

export type YouTubeRun = {
  /** Queue index of the first video of the run. */
  start: number;
  /** Video ids of the run, in queue order (at most YOUTUBE_RUN_LIMIT). */
  videoIds: string[];
  /** Position of the current item inside `videoIds`. */
  offset: number;
};

/**
 * Video id of a plain YouTube item. Null for Audius, podcast, radio and Jamendo items and for an
 * imported 'song' not resolved yet (it is looked up on YouTube only when its turn comes).
 */
export function runVideoId(item: RunQueueItem | null | undefined): string | null {
  if (!item || item.playbackMode !== 'youtube') return null;
  return QUALIFIED_VIDEO.exec(item.qualifiedId)?.[1] ?? null;
}

/**
 * The maximal run of consecutive plain YouTube items around `index`, capped to `limit` videos with
 * the current item inside the window (as many following videos as possible: those are the ones
 * YouTube prepares). Null when the current item is not a plain YouTube item.
 */
export function youtubeRunAt(
  queue: ReadonlyArray<RunQueueItem | null | undefined>,
  index: number,
  limit = YOUTUBE_RUN_LIMIT,
): YouTubeRun | null {
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) return null;
  if (!runVideoId(queue[index])) return null;
  let first = index;
  while (first > 0 && runVideoId(queue[first - 1])) first -= 1;
  let last = index;
  while (last < queue.length - 1 && runVideoId(queue[last + 1])) last += 1;
  const cap = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : YOUTUBE_RUN_LIMIT));
  const start = Math.max(first, Math.min(index, last - cap + 1));
  const end = Math.min(last, start + cap - 1);
  const videoIds: string[] = [];
  for (let item = start; item <= end; item += 1) {
    const videoId = runVideoId(queue[item]);
    if (videoId) videoIds.push(videoId);
  }
  return { start, videoIds, offset: index - start };
}

/** `index` is a video of `run` and the queue still holds the run's videos at the same places. */
export function runHoldsIndex(
  run: YouTubeRun | null | undefined,
  queue: ReadonlyArray<RunQueueItem | null | undefined>,
  index: number,
): run is YouTubeRun {
  if (!run || index < run.start || index >= run.start + run.videoIds.length) return false;
  return run.videoIds.every(
    (videoId, position) => runVideoId(queue[run.start + position]) === videoId,
  );
}

/** True when the item at `index` is not the last video of the run (YouTube moves on by itself). */
export function continuesInRun(run: YouTubeRun, index: number) {
  return index >= run.start && index < run.start + run.videoIds.length - 1;
}

/** What the official player says it is playing (getPlaylistIndex / getVideoData). */
export type PlayerReport = { playlistIndex?: unknown; videoId?: unknown };

type ReportingPlayer = {
  getPlaylistIndex?: () => number;
  getVideoData?: () => { video_id?: string } | null | undefined;
};

/** Reads the official player's playlist position and video id; missing or throwing getters → undefined. */
export function readPlayerReport(player: ReportingPlayer): PlayerReport {
  const report: PlayerReport = {};
  try {
    report.playlistIndex = player.getPlaylistIndex?.();
  } catch {
    // Player still starting.
  }
  try {
    report.videoId = player.getVideoData?.()?.video_id;
  } catch {
    // Player still starting.
  }
  return report;
}

/**
 * Position in `run` of the video the official player reports, or null when the report does not
 * belong to the run (another playlist, an unknown video). The playlist index counts only when it
 * agrees with the reported video; otherwise the video id decides, nearest to `near` if repeated.
 */
export function reportedRunPosition(
  run: YouTubeRun,
  report: PlayerReport,
  near = run.offset,
): number | null {
  const videoId =
    typeof report.videoId === 'string' && VIDEO_ID.test(report.videoId) ? report.videoId : null;
  const index = report.playlistIndex;
  if (
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < run.videoIds.length &&
    (videoId === null || run.videoIds[index] === videoId)
  ) {
    return index;
  }
  if (videoId === null) return null;
  let best: number | null = null;
  run.videoIds.forEach((candidate, position) => {
    if (candidate !== videoId) return;
    if (best === null || Math.abs(position - near) < Math.abs(best - near)) best = position;
  });
  return best;
}

/**
 * False when the official player says its playlist is not `run` (getPlaylist lists other videos,
 * or none): YouTube will not move on to the run's next video by itself, so the app has to. A player
 * without the getter, or one that throws, is trusted (no change from waiting on YouTube).
 */
export function playerListsRun(
  player: { getPlaylist?: () => unknown } | null | undefined,
  run: YouTubeRun,
): boolean {
  if (!player || typeof player.getPlaylist !== 'function') return true;
  let listed: unknown;
  try {
    listed = player.getPlaylist();
  } catch {
    return true;
  }
  return (
    Array.isArray(listed) &&
    listed.length === run.videoIds.length &&
    run.videoIds.every((videoId, position) => listed[position] === videoId)
  );
}

/**
 * A move the app asked of the official player (next, previous, a queue tap, a new load) that
 * YouTube has not reported yet. `from` is the queue index the player was on, when known.
 */
export type PendingRunMove = { index: number; from: number | null };

/**
 * A report of queue index `index` that predates the app's pending move: the video that was playing
 * when the move was asked, or the one YouTube was already advancing to from it. The app must not
 * follow it (its own command is about to land).
 */
export function predatesMove(pending: PendingRunMove | null | undefined, index: number) {
  if (!pending || pending.from === null || index === pending.index) return false;
  return index === pending.from || index === pending.from + 1;
}

export type RunMove = { kind: 'next' } | { kind: 'previous' } | { kind: 'at'; position: number };

/** nextVideo() / previousVideo() for a neighbour of the player's position, playVideoAt() otherwise. */
export function runMoveCommand(from: number | null, to: number): RunMove {
  if (from !== null && to === from + 1) return { kind: 'next' };
  if (from !== null && to === from - 1) return { kind: 'previous' };
  return { kind: 'at', position: to };
}
