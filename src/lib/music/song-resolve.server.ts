// @polsia:user-owned — trova su YouTube il video di un brano importato (artista + titolo),
// solo quando qualcuno lo ascolta. Risultato condiviso tra gli utenti per risparmiare quota.
// La chiave della cache è la forma canonica del brano (le stesse parole che decidono la ricerca
// e la scelta), e i dati YouTube non restano mai più di 29 giorni da quando sono arrivati.
import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { pickVideoForSong, songCanonical } from '@/lib/music/background-match';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import {
  withYouTubeSearchBudget,
  type YouTubeSearchLoader,
} from '@/lib/music/youtube-budget.server';
import {
  searchYouTubeMusic,
  type YouTubeUnavailableReason,
} from '@/lib/music/youtube-search.server';
import { storedYouTubeSearchWithTime } from '@/lib/music/youtube-search-store.server';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * YouTube API data may be kept less than 30 days: 28 days from when YouTube sent it, so with the
 * daily cleanup (which deletes expired rows) nothing is stored longer than about 29 days.
 */
export const FOUND_TTL_MS = 28 * DAY_MS;
/**
 * A song YouTube does not have is retried after a week, not on every play: a "not found" holds
 * no YouTube data, and every retry is a full search.
 */
export const NOT_FOUND_TTL_MS = 7 * DAY_MS;
/** "Not found" decided on an older saved search is checked again sooner. */
export const NOT_FOUND_ON_SAVED_TTL_MS = DAY_MS;
/** How many videos of a song search are compared (YouTube is always asked for 25). */
const SONG_SEARCH_RESULTS = 10;

export type ResolvedVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
};
export type SongResolution =
  | { ok: true; video: ResolvedVideo | null }
  | { ok: false; error: 'unavailable'; reason?: YouTubeUnavailableReason };

/** Cache key: hash of the canonical words, so equal searches share one entry. */
export function songResolutionKey(title: string, artist: string | null) {
  return createHash('sha256')
    .update(songCanonical({ title, artist }).key)
    .digest('hex')
    .slice(0, 40);
}

/** The YouTube query actually sent: letters and digits only. */
export function songSearchQuery(title: string, artist: string | null) {
  return songCanonical({ title, artist }).query;
}

/** A cached answer (video or "not found"), or null when YouTube must be asked. */
export async function peekSongResolution(
  title: string,
  artist: string | null,
  now = new Date(),
): Promise<SongResolution | null> {
  const key = songResolutionKey(title, artist);
  const saved = await Promise.resolve()
    .then(() => prisma.songResolution.findUnique({ where: { key } }))
    .catch(() => null);
  // Rows written before the 28-day limit could expire up to 29 days after the fetch: whatever
  // their expiry says, YouTube data older than FOUND_TTL_MS is not served.
  if (
    !saved ||
    saved.expiresAt <= now ||
    now.getTime() - saved.createdAt.getTime() >= FOUND_TTL_MS
  ) {
    return null;
  }
  return {
    ok: true,
    video:
      saved.videoId && saved.title && saved.channelTitle
        ? {
            videoId: saved.videoId,
            title: saved.title,
            channelTitle: saved.channelTitle,
            thumbnailUrl: saved.thumbnailUrl,
          }
        : null,
  };
}

/**
 * Searches YouTube (shared 24 h search cache first) and stores the choice. A real search uses the
 * imported-songs share of the daily budget (search:song), only when no saved search answers.
 */
export async function searchSong(
  title: string,
  artist: string | null,
  now = new Date(),
): Promise<SongResolution> {
  const canonical = songCanonical({ title, artist });
  if (!canonical.query) return { ok: true, video: null };
  const apiKey = readYouTubeApiKey();
  // Without a key no search can run: do not take a slot of the budget for nothing.
  const load: YouTubeSearchLoader = apiKey
    ? withYouTubeSearchBudget((term, size) => searchYouTubeMusic(term, apiKey, fetch, size), {
        purpose: 'song',
      })
    : async () => ({ outcome: 'unavailable', videos: [], unavailableReason: 'not_configured' });
  const { result, fetchedAt, stale, blockedBy } = await storedYouTubeSearchWithTime(
    canonical.query,
    SONG_SEARCH_RESULTS,
    load,
  );
  // Quota finished or API error: do not remember "not found" for something we could not check.
  if (result.outcome === 'unavailable') {
    return { ok: false, error: 'unavailable', reason: blockedBy ?? result.unavailableReason };
  }
  const picked = pickVideoForSong({ title, artist }, result.videos);
  const video = picked
    ? {
        videoId: picked.videoId,
        title: picked.title,
        channelTitle: picked.channelTitle,
        thumbnailUrl: picked.thumbnailUrl ?? null,
      }
    : null;
  // The 28 days count from when YouTube sent the data, even if it came from the search cache.
  const expiresAt = new Date(
    video
      ? fetchedAt.getTime() + FOUND_TTL_MS
      : now.getTime() + (stale ? NOT_FOUND_ON_SAVED_TTL_MS : NOT_FOUND_TTL_MS),
  );
  if (expiresAt > now) {
    const key = songResolutionKey(title, artist);
    const data = {
      videoId: video?.videoId ?? null,
      title: video?.title ?? null,
      channelTitle: video?.channelTitle ?? null,
      thumbnailUrl: video?.thumbnailUrl ?? null,
      createdAt: fetchedAt,
      expiresAt,
    };
    await Promise.resolve()
      .then(() =>
        prisma.songResolution.upsert({ where: { key }, create: { key, ...data }, update: data }),
      )
      .catch(() => undefined);
  }
  return { ok: true, video };
}

/** Cache first, then YouTube. */
export async function resolveSong(
  title: string,
  artist: string | null,
  now = new Date(),
): Promise<SongResolution> {
  return (await peekSongResolution(title, artist, now)) ?? searchSong(title, artist, now);
}

/**
 * The chosen video would not play (removed, private, not embeddable): forget that choice, but
 * only if the cache still holds exactly that video.
 */
export async function invalidateSongResolution(
  title: string,
  artist: string | null,
  videoId: string,
  now = new Date(),
) {
  const key = songResolutionKey(title, artist);
  await prisma.songResolution
    .updateMany({ where: { key, videoId }, data: { expiresAt: now } })
    .catch(() => undefined);
}
