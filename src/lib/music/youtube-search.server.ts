// @polsia:user-owned
import 'server-only';
import type { YouTubeVideoSearchResult } from '@/lib/contracts/music';

export type YouTubeUnavailableReason = 'not_configured' | 'quota_exceeded' | 'api_error';
export type YouTubeSearchResult = {
  videos: YouTubeVideoSearchResult[];
  outcome: 'results' | 'no_results' | 'unavailable';
  unavailableReason?: YouTubeUnavailableReason;
};

export type YouTubeVideoDetails = {
  video: YouTubeVideoSearchResult;
  madeForKids: boolean | null;
};

type YouTubeItem = {
  id?: { videoId?: unknown } | unknown;
  snippet?: {
    title?: unknown;
    channelTitle?: unknown;
    channelId?: unknown;
    description?: unknown;
    publishedAt?: unknown;
    thumbnails?: unknown;
  };
  status?: { madeForKids?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isYouTubeSnippet(value: unknown): value is NonNullable<YouTubeItem['snippet']> {
  return isRecord(value);
}

function errorReason(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || !Array.isArray(value.error.errors)) return null;
  for (const item of value.error.errors) {
    if (isRecord(item) && typeof item.reason === 'string') return item.reason;
  }
  return null;
}

function unavailable(reason: YouTubeUnavailableReason): YouTubeSearchResult {
  return { videos: [], outcome: 'unavailable', unavailableReason: reason };
}

function quotaExceeded(reason: string | null) {
  return [
    'quotaExceeded',
    'dailyLimitExceeded',
    'userRateLimitExceeded',
    'rateLimitExceeded',
  ].includes(reason ?? '');
}

function thumbnailUrl(snippet: YouTubeItem['snippet']): string | null {
  const thumbnails = snippet?.thumbnails;
  if (!isRecord(thumbnails)) return null;
  const medium = thumbnails.medium;
  const high = thumbnails.high;
  const defaultThumbnail = thumbnails.default;
  const candidate = [medium, high, defaultThumbnail].find(isRecord);
  const urlValue = candidate?.url;
  if (typeof urlValue !== 'string') return null;
  try {
    const url = new URL(urlValue);
    return url.protocol === 'https:' && url.hostname === 'i.ytimg.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

const htmlEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** YouTube Data API returns HTML-escaped titles (e.g. "&amp;", "&#39;"). */
export function decodeYouTubeText(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1]?.toLowerCase() === 'x'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    }
    return htmlEntities[code.toLowerCase()] ?? match;
  });
}

export function normalizeYouTubeVideo(item: unknown): YouTubeVideoSearchResult | null {
  if (!isRecord(item)) return null;
  const id = isRecord(item.id) ? item.id.videoId : item.id;
  const snippet = isYouTubeSnippet(item.snippet) ? item.snippet : undefined;
  if (!snippet) return null;
  const title = snippet?.title;
  const channelTitle = snippet?.channelTitle;
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{11}$/.test(id) ||
    typeof title !== 'string' ||
    !title.trim() ||
    typeof channelTitle !== 'string' ||
    !channelTitle.trim()
  ) {
    return null;
  }

  const publishedAtValue = snippet?.publishedAt;
  const publishedAt =
    typeof publishedAtValue === 'string' && Number.isFinite(Date.parse(publishedAtValue))
      ? new Date(publishedAtValue).toISOString()
      : null;
  const channelId =
    typeof snippet?.channelId === 'string' && snippet.channelId.trim()
      ? snippet.channelId.trim()
      : null;

  return {
    provider: 'youtube',
    videoId: id,
    title: decodeYouTubeText(title.trim()),
    channelTitle: decodeYouTubeText(channelTitle.trim()),
    channelId,
    description:
      typeof snippet.description === 'string' && snippet.description.trim()
        ? decodeYouTubeText(snippet.description.trim())
        : null,
    publishedAt,
    thumbnailUrl: thumbnailUrl(snippet),
  };
}

function responseUrl(path: string) {
  return new URL(`https://www.googleapis.com/youtube/v3/${path}`);
}

async function requestJson(
  url: URL,
  fetcher: typeof fetch,
): Promise<{
  ok: boolean;
  status: number;
  payload: unknown;
}> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      payload: await response.json().catch(() => null),
    };
  } catch {
    return { ok: false, status: 0, payload: null };
  }
}

export async function searchYouTubeMusic(
  query: string,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
  maxResults = 10,
): Promise<YouTubeSearchResult> {
  const term = query.trim();
  if (!term) return { videos: [], outcome: 'no_results' };
  if (!apiKey?.trim()) return unavailable('not_configured');

  const url = responseUrl('search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('videoEmbeddable', 'true');
  url.searchParams.set('safeSearch', 'moderate');
  url.searchParams.set('maxResults', String(Math.min(50, Math.max(1, maxResults))));
  url.searchParams.set('q', term);
  url.searchParams.set('key', apiKey.trim());

  const result = await requestJson(url, fetcher);
  if (!result.ok) {
    const reason = errorReason(result.payload);
    return unavailable(quotaExceeded(reason) ? 'quota_exceeded' : 'api_error');
  }
  if (!isRecord(result.payload) || !Array.isArray(result.payload.items)) {
    return unavailable('api_error');
  }
  const videos = result.payload.items
    .filter(isRecord)
    .map(normalizeYouTubeVideo)
    .filter((video): video is YouTubeVideoSearchResult => video !== null);
  if (result.payload.items.length > 0 && videos.length === 0) return unavailable('api_error');
  return videos.length > 0 ? { videos, outcome: 'results' } : { videos: [], outcome: 'no_results' };
}

export async function getYouTubeVideoDetails(
  id: string,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<
  | { outcome: 'found'; details: YouTubeVideoDetails }
  | { outcome: 'not_found' | 'api_error' | 'quota_exceeded' | 'not_configured' }
> {
  if (!apiKey?.trim()) return { outcome: 'not_configured' };
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return { outcome: 'not_found' };

  const url = responseUrl('videos');
  url.searchParams.set('part', 'snippet,status');
  url.searchParams.set('id', id);
  url.searchParams.set('key', apiKey.trim());
  const result = await requestJson(url, fetcher);
  if (!result.ok) {
    return { outcome: quotaExceeded(errorReason(result.payload)) ? 'quota_exceeded' : 'api_error' };
  }
  if (!isRecord(result.payload) || !Array.isArray(result.payload.items)) {
    return { outcome: 'api_error' };
  }
  const item = result.payload.items.find(isRecord);
  if (!item) return { outcome: 'not_found' };
  const video = normalizeYouTubeVideo(item);
  if (!video || video.videoId !== id) return { outcome: 'api_error' };
  const videoStatus = isRecord(item.status) ? item.status : null;
  const madeForKids =
    typeof videoStatus?.madeForKids === 'boolean' ? videoStatus.madeForKids : null;
  return { outcome: 'found', details: { video, madeForKids } };
}

/** Durata ISO 8601 di YouTube (es. PT3M21S) in secondi; null se assente o non valida. */
export function parseYouTubeDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, d = '0', h = '0', m = '0', s = '0'] = match;
  const total = Number(d) * 86_400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  return total > 0 ? total : null;
}

export type YouTubeChartVideo = YouTubeVideoSearchResult & { durationSeconds: number | null };

/** Classifica dei video musicali più popolari in un paese (videos.list chart=mostPopular, 1 unità di quota). */
export async function getYouTubeMusicChart(
  regionCode: string,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ outcome: 'results' | 'no_results' | 'unavailable'; videos: YouTubeChartVideo[] }> {
  if (!apiKey?.trim()) return { outcome: 'unavailable', videos: [] };
  const url = responseUrl('videos');
  url.searchParams.set('part', 'snippet,contentDetails,status');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('regionCode', regionCode);
  url.searchParams.set('maxResults', '30');
  url.searchParams.set('key', apiKey.trim());
  const result = await requestJson(url, fetcher);
  if (!result.ok || !isRecord(result.payload) || !Array.isArray(result.payload.items)) {
    return { outcome: 'unavailable', videos: [] };
  }
  const videos = result.payload.items
    .filter(isRecord)
    .filter((item) => !isRecord(item.status) || item.status.embeddable !== false)
    .map((item) => {
      const video = normalizeYouTubeVideo(item);
      if (!video) return null;
      const details = isRecord(item.contentDetails) ? item.contentDetails : {};
      return { ...video, durationSeconds: parseYouTubeDuration(details.duration) };
    })
    .filter((video): video is YouTubeChartVideo => video !== null);
  return { outcome: videos.length ? 'results' : 'no_results', videos };
}
