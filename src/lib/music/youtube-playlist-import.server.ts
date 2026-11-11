// @polsia:user-owned — importa una playlist pubblica YouTube come playlist Solco.
// I metadati YouTube scadono come gli altri elementi YouTube (youtubeMetadataExpiry).
import 'server-only';
import type { YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { normalizeYouTubeVideo } from '@/lib/music/youtube-search.server';

const MAX_ITEMS = 100;
const PAGE_SIZE = 50;
// Video privati/eliminati vengono saltati: senza un tetto alle pagine una playlist di soli
// elementi non disponibili verrebbe sfogliata per intero (1 unità di quota per pagina).
const MAX_PAGES = Math.ceil(MAX_ITEMS / PAGE_SIZE) + 2;

export class YouTubeImportError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'not_configured' | 'not_found' | 'quota_exceeded' | 'api_error',
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeImportError';
  }
}

/** Estrae l'ID playlist da un link YouTube (…?list=ID) o da un ID nudo. */
export function parsePlaylistId(input: string) {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{10,64}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host !== 'youtube.com' && host !== 'youtu.be') return null;
    const list = url.searchParams.get('list');
    return list && /^[A-Za-z0-9_-]{10,64}$/.test(list) ? list : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function youtubeGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  fetcher: typeof fetch,
) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('key', apiKey);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new YouTubeImportError('api_error', 'YouTube non ha risposto. Riprova più tardi.');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason =
      isRecord(payload) && isRecord(payload.error) && Array.isArray(payload.error.errors)
        ? (payload.error.errors.find(isRecord)?.reason as string | undefined)
        : undefined;
    if (reason && /quota|RateLimit/i.test(reason)) {
      throw new YouTubeImportError('quota_exceeded', 'Quota YouTube esaurita per oggi.');
    }
    if (response.status === 404) {
      throw new YouTubeImportError('not_found', 'Playlist YouTube non trovata o privata.');
    }
    throw new YouTubeImportError('api_error', 'YouTube ha restituito un errore.');
  }
  return isRecord(payload) ? payload : {};
}

export async function fetchYouTubePlaylist(
  playlistId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<{ title: string; videos: YouTubeVideoSearchResult[]; skipped: number }> {
  if (!apiKey) {
    throw new YouTubeImportError(
      'not_configured',
      'Manca il segreto server-side YOUTUBE_DATA_API_KEY.',
    );
  }
  const meta = await youtubeGet('playlists', { part: 'snippet', id: playlistId }, apiKey, fetcher);
  const playlist = Array.isArray(meta.items) ? meta.items.find(isRecord) : undefined;
  const snippet = playlist && isRecord(playlist.snippet) ? playlist.snippet : null;
  if (!snippet)
    throw new YouTubeImportError('not_found', 'Playlist YouTube non trovata o privata.');
  const title =
    typeof snippet.title === 'string' && snippet.title.trim()
      ? snippet.title.trim().slice(0, 50)
      : 'Playlist YouTube';

  const videos: YouTubeVideoSearchResult[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let pageToken: string | undefined;
  let pages = 0;
  do {
    pages += 1;
    const page = await youtubeGet(
      'playlistItems',
      {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: String(PAGE_SIZE),
        ...(pageToken ? { pageToken } : {}),
      },
      apiKey,
      fetcher,
    );
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
      if (videos.length >= MAX_ITEMS) break;
    }
    pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
  } while (pageToken && videos.length < MAX_ITEMS && pages < MAX_PAGES);

  return { title, videos, skipped };
}
