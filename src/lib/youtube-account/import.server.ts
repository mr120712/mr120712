// @polsia:user-owned — elenca le playlist dell'account YouTube collegato (anche private) e le
// importa come playlist Solco (riferimenti ai videoId, riprodotti on-demand). Re-sync a specchio
// per `youtubeSource='playlist:<id>'`. Ogni pagina Data API costa 1 unità di quota: si passa dal
// budget condiviso della libreria (takeYouTubeUnits/noteYouTubeQuotaExceeded).
import 'server-only';
import {
  type UpsertResult,
  upsertYouTubeVideoPlaylist,
} from '@/lib/business/track-list-import.server';
import type { YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { prisma } from '@/lib/db';
import { MAX_ITEMS_PER_COLLECTION } from '@/lib/music/collections.server';
import { noteYouTubeQuotaExceeded, takeYouTubeUnits } from '@/lib/music/youtube-budget.server';
import { normalizeYouTubeVideo } from '@/lib/music/youtube-search.server';
import {
  describeYouTubeError,
  type YouTubeAuth,
  YouTubeError,
  type YouTubeFetchOptions,
  youtubeFetch,
} from '@/lib/youtube-account/client.server';

const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const PLAYLIST_PAGE_SIZE = 50;
const MAX_PLAYLIST_PAGES = Math.ceil(MAX_ITEMS_PER_COLLECTION / PLAYLIST_PAGE_SIZE) + 2;
/** Cap on how many of the user's playlists we page through for the picker. */
const MAX_LISTED_PLAYLISTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 1 unità di quota prima di ogni chiamata; il budget esaurito diventa YouTubeError 'quota_exceeded'. */
async function call(
  path: string,
  auth: YouTubeAuth,
  options: YouTubeFetchOptions,
): Promise<Record<string, unknown>> {
  if (!(await takeYouTubeUnits(1, { purpose: 'library' }))) {
    throw new YouTubeError({ status: 429, reason: 'quota_exceeded' });
  }
  try {
    const json = await youtubeFetch(path, auth, options);
    return isRecord(json) ? json : {};
  } catch (error) {
    if (error instanceof YouTubeError && error.reason === 'quota_exceeded') {
      await noteYouTubeQuotaExceeded('units');
    }
    throw error;
  }
}

function pickThumbnail(snippet: Record<string, unknown>): string | null {
  const thumbs = isRecord(snippet.thumbnails) ? snippet.thumbnails : null;
  if (!thumbs) return null;
  for (const size of ['medium', 'high', 'default', 'standard', 'maxres']) {
    const t = isRecord(thumbs[size]) ? thumbs[size] : null;
    if (t && typeof t.url === 'string' && /^https:\/\//.test(t.url)) return t.url;
  }
  return null;
}

export type YouTubeAccountPlaylist = {
  id: string;
  title: string;
  itemCount: number | null;
  thumbnailUrl: string | null;
};

export type YouTubePlaylistsPage = {
  playlists: YouTubeAccountPlaylist[];
  nextPageToken: string | null;
};

function mapPlaylist(item: Record<string, unknown>): YouTubeAccountPlaylist | null {
  const id = item.id;
  if (typeof id !== 'string' || !PLAYLIST_ID_PATTERN.test(id)) return null;
  const snippet = isRecord(item.snippet) ? item.snippet : {};
  const contentDetails = isRecord(item.contentDetails) ? item.contentDetails : {};
  const title =
    typeof snippet.title === 'string' && snippet.title.trim()
      ? snippet.title.trim().slice(0, 120)
      : 'Playlist YouTube';
  const itemCount = typeof contentDetails.itemCount === 'number' ? contentDetails.itemCount : null;
  return { id, title, itemCount, thumbnailUrl: pickThumbnail(snippet) };
}

/** Una pagina delle playlist dell'utente collegato (anche private). */
export async function listMyPlaylists(
  auth: YouTubeAuth,
  pageToken?: string,
  options: YouTubeFetchOptions = {},
): Promise<YouTubePlaylistsPage> {
  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    mine: 'true',
    maxResults: String(PLAYLIST_PAGE_SIZE),
  });
  if (pageToken) params.set('pageToken', pageToken);
  const page = await call(`/playlists?${params.toString()}`, auth, options);
  const items = Array.isArray(page.items) ? page.items.filter(isRecord) : [];
  const playlists = items
    .map(mapPlaylist)
    .filter((p): p is YouTubeAccountPlaylist => p !== null)
    .slice(0, MAX_LISTED_PLAYLISTS);
  const next = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
  return { playlists, nextPageToken: next };
}

async function fetchPlaylistTitle(
  playlistId: string,
  auth: YouTubeAuth,
  options: YouTubeFetchOptions,
): Promise<string> {
  const page = await call(
    `/playlists?part=snippet&id=${encodeURIComponent(playlistId)}`,
    auth,
    options,
  );
  const item = Array.isArray(page.items) ? page.items.find(isRecord) : undefined;
  const snippet = item && isRecord(item.snippet) ? item.snippet : null;
  if (!snippet) throw new YouTubeError({ status: 404, reason: 'not_found' });
  return typeof snippet.title === 'string' && snippet.title.trim()
    ? snippet.title.trim().slice(0, 50)
    : 'Playlist YouTube';
}

async function collectPlaylistVideos(
  playlistId: string,
  auth: YouTubeAuth,
  options: YouTubeFetchOptions,
): Promise<{ videos: YouTubeVideoSearchResult[]; skipped: number }> {
  const videos: YouTubeVideoSearchResult[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let pageToken: string | undefined;
  let pages = 0;
  do {
    pages += 1;
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: String(PLAYLIST_PAGE_SIZE),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await call(`/playlistItems?${params.toString()}`, auth, options);
    for (const item of Array.isArray(page.items) ? page.items.filter(isRecord) : []) {
      const details = isRecord(item.contentDetails) ? item.contentDetails : {};
      const itemSnippet = isRecord(item.snippet) ? item.snippet : {};
      const video = normalizeYouTubeVideo({
        id: details.videoId,
        snippet: {
          ...itemSnippet,
          // Playlist items carry the playlist owner in channelTitle; use the video owner.
          channelTitle: itemSnippet.videoOwnerChannelTitle,
          channelId: itemSnippet.videoOwnerChannelId,
        },
      });
      if (!video || seen.has(video.videoId)) {
        skipped += 1;
        continue;
      }
      seen.add(video.videoId);
      videos.push(video);
      if (videos.length >= MAX_ITEMS_PER_COLLECTION) break;
    }
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
  } while (pageToken && videos.length < MAX_ITEMS_PER_COLLECTION && pages < MAX_PLAYLIST_PAGES);
  return { videos, skipped };
}

// ---------------------------------------------------------------------------------------------
// Re-sync keying: 'playlist:<id>' su UserMusicCollection.youtubeSource.

export function youtubeSourceDb(playlistId: string): string {
  return `playlist:${playlistId}`;
}

export function dbToYouTubePlaylistId(db: string): string | null {
  const match = /^playlist:([A-Za-z0-9_-]{10,64})$/.exec(db);
  return match?.[1] ?? null;
}

/** La playlist non ha video riproducibili: non svuotare un'eventuale playlist Solco esistente. */
export class EmptyPlaylistError extends Error {
  constructor(readonly playlistId: string) {
    super('empty playlist');
    this.name = 'EmptyPlaylistError';
  }
}

export type ImportedPlaylist = {
  collectionId: string;
  name: string;
  playlistId: string;
  imported: number;
  skipped: number;
  added: number;
  removed: number;
};

export type ImportFailure = { playlistId: string; error: string; message: string };

async function importOnePlaylist(
  userId: string,
  playlistId: string,
  auth: YouTubeAuth,
  options: YouTubeFetchOptions,
): Promise<UpsertResult & { playlistId: string; imported: number; skipped: number }> {
  const title = await fetchPlaylistTitle(playlistId, auth, options);
  const { videos, skipped } = await collectPlaylistVideos(playlistId, auth, options);
  if (videos.length === 0) throw new EmptyPlaylistError(playlistId);
  const result = await upsertYouTubeVideoPlaylist(
    userId,
    youtubeSourceDb(playlistId),
    title,
    videos,
  );
  return { ...result, playlistId, imported: videos.length, skipped };
}

function toEntry(
  r: UpsertResult & { playlistId: string; imported: number; skipped: number },
): ImportedPlaylist {
  return {
    collectionId: r.collectionId,
    name: r.name,
    playlistId: r.playlistId,
    imported: r.imported,
    skipped: r.skipped,
    added: r.added,
    removed: r.removed,
  };
}

/** True quando l'errore è "di questa playlist" (va in failed) e non fa abortire il resto. */
function perPlaylistFailure(error: unknown, playlistId: string): ImportFailure | null {
  if (error instanceof EmptyPlaylistError) {
    return {
      playlistId,
      error: 'empty',
      message: 'La playlist non contiene video riproducibili.',
    };
  }
  if (
    error instanceof YouTubeError &&
    (error.reason === 'not_found' || error.reason === 'forbidden')
  ) {
    const d = describeYouTubeError(error);
    return { playlistId, error: d.error, message: d.message };
  }
  return null;
}

export type YouTubeImportResult = {
  created: ImportedPlaylist[];
  updated: ImportedPlaylist[];
  failed: ImportFailure[];
};

/** Importa (o aggiorna) le playlist indicate. reauth/quota/unavailable interrompono il resto. */
export async function runYouTubeImport(
  userId: string,
  playlistIds: string[],
  auth: YouTubeAuth,
  options: YouTubeFetchOptions = {},
): Promise<YouTubeImportResult> {
  const created: ImportedPlaylist[] = [];
  const updated: ImportedPlaylist[] = [];
  const failed: ImportFailure[] = [];
  for (const [i, id] of playlistIds.entries()) {
    try {
      const r = await importOnePlaylist(userId, id, auth, options);
      (r.created ? created : updated).push(toEntry(r));
    } catch (error) {
      const perPlaylist = perPlaylistFailure(error, id);
      if (perPlaylist) {
        failed.push(perPlaylist);
        continue;
      }
      // Fatale (reauth/quota/unavailable): se nulla è stato fatto, propaga; altrimenti segna il
      // resto come fallito e fermati.
      if (created.length === 0 && updated.length === 0) throw error;
      const d = describeYouTubeError(error);
      for (const rest of playlistIds.slice(i)) {
        failed.push({ playlistId: rest, error: d.error, message: d.message });
      }
      break;
    }
  }
  return { created, updated, failed };
}

export type YouTubeSyncResult = {
  updated: ImportedPlaylist[];
  failed: ImportFailure[];
  nothingToSync: boolean;
};

/** Risincronizza a specchio tutte le playlist Solco importate da YouTube. */
export async function runYouTubeSync(
  userId: string,
  auth: YouTubeAuth,
  options: YouTubeFetchOptions = {},
): Promise<YouTubeSyncResult> {
  const rows = await prisma.userMusicCollection.findMany({
    where: { userId, youtubeSource: { not: null } },
    select: { youtubeSource: true },
    orderBy: { updatedAt: 'asc' },
  });
  const ids = rows
    .map((row) => (row.youtubeSource ? dbToYouTubePlaylistId(row.youtubeSource) : null))
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return { updated: [], failed: [], nothingToSync: true };
  const updated: ImportedPlaylist[] = [];
  const failed: ImportFailure[] = [];
  for (const [i, id] of ids.entries()) {
    try {
      const r = await importOnePlaylist(userId, id, auth, options);
      updated.push(toEntry(r));
    } catch (error) {
      const perPlaylist = perPlaylistFailure(error, id);
      if (perPlaylist) {
        failed.push(perPlaylist);
        continue;
      }
      if (updated.length === 0) throw error;
      const d = describeYouTubeError(error);
      for (const rest of ids.slice(i)) {
        failed.push({ playlistId: rest, error: d.error, message: d.message });
      }
      break;
    }
  }
  return { updated, failed, nothingToSync: false };
}
