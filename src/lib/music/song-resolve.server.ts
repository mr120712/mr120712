// @polsia:user-owned — trova su YouTube il video di un brano importato (artista + titolo),
// solo quando qualcuno lo ascolta. Risultato condiviso tra gli utenti per risparmiare quota.
import 'server-only';
import { songSourceId } from '@/lib/business/track-list-import.server';
import { prisma } from '@/lib/db';
import { pickVideoForSong } from '@/lib/music/background-match';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { searchYouTubeMusic } from '@/lib/music/youtube-search.server';
import { storedYouTubeSearch } from '@/lib/music/youtube-search-store.server';

const DAY_MS = 24 * 60 * 60 * 1000;
/** YouTube API data may be kept less than 30 days. */
export const FOUND_TTL_MS = 29 * DAY_MS;
/** A song YouTube does not have is retried after a day, not on every play. */
export const NOT_FOUND_TTL_MS = DAY_MS;

export type ResolvedVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
};
export type SongResolution =
  | { ok: true; video: ResolvedVideo | null }
  | { ok: false; error: 'unavailable' };

export function songSearchQuery(title: string, artist: string | null) {
  const baseTitle = title.split(/\s[-–—]\s/)[0] ?? title;
  const mainArtist = (artist ?? '').split(/\s*,\s*/)[0] ?? '';
  return `${mainArtist} ${baseTitle}`.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export async function resolveSong(
  title: string,
  artist: string | null,
  now = new Date(),
): Promise<SongResolution> {
  const key = songSourceId(title, artist);
  const saved = await Promise.resolve()
    .then(() => prisma.songResolution.findUnique({ where: { key } }))
    .catch(() => null);
  if (saved && saved.expiresAt > now) {
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

  const query = songSearchQuery(title, artist);
  const result = await storedYouTubeSearch(query, 10, () =>
    searchYouTubeMusic(query, readYouTubeApiKey(), fetch, 10),
  );
  // Quota finished or API error: do not remember "not found" for something we could not check.
  if (result.outcome === 'unavailable') return { ok: false, error: 'unavailable' };
  const picked = pickVideoForSong({ title, artist }, result.videos);
  const video = picked
    ? {
        videoId: picked.videoId,
        title: picked.title,
        channelTitle: picked.channelTitle,
        thumbnailUrl: picked.thumbnailUrl ?? null,
      }
    : null;
  const data = {
    videoId: video?.videoId ?? null,
    title: video?.title ?? null,
    channelTitle: video?.channelTitle ?? null,
    thumbnailUrl: video?.thumbnailUrl ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + (video ? FOUND_TTL_MS : NOT_FOUND_TTL_MS)),
  };
  await Promise.resolve()
    .then(() =>
      prisma.songResolution.upsert({ where: { key }, create: { key, ...data }, update: data }),
    )
    .catch(() => undefined);
  await Promise.resolve()
    .then(() => prisma.songResolution.deleteMany({ where: { expiresAt: { lte: now } } }))
    .catch(() => undefined);
  return { ok: true, video };
}
