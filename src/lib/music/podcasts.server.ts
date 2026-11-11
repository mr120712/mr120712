// @polsia:user-owned — podcast: ricerca e classifiche dalla directory pubblica iTunes,
// episodi dal feed RSS pubblico dello show. Gli episodi si ascoltano dal file audio ufficiale.
import 'server-only';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Podcast, PodcastEpisode } from '@/lib/contracts/library';

const ITUNES = 'https://itunes.apple.com';
const TOP_CHART = 'https://rss.applemarketingtools.com/api/v2';
const COUNTRY = 'it';
const TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 6 * 1024 * 1024;
const MAX_EPISODES = 100;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 150;

type FetchLike = typeof fetch;
type Outcome = 'results' | 'no_results' | 'unavailable';

const cache = new Map<string, { expires: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function remember(key: string, value: unknown) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

export function clearPodcastCache() {
  cache.clear();
}

function text(value: unknown, max: number) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function httpsOrNull(value: unknown) {
  const raw = text(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------- Directory (iTunes) ----------

export function normalizeItunesPodcast(raw: Record<string, unknown>): Podcast | null {
  const id = text(raw.collectionId ?? raw.id, 20);
  const title = text(raw.collectionName ?? raw.name, 300);
  if (!id || !/^[0-9]{1,20}$/.test(id) || !title) return null;
  const genres = Array.isArray(raw.genres) ? (raw.genres as Array<Record<string, unknown>>) : [];
  return {
    id,
    title,
    author: text(raw.artistName, 300),
    artworkUrl: httpsOrNull(raw.artworkUrl600 ?? raw.artworkUrl100),
    genre: text(raw.primaryGenreName ?? genres[0]?.name, 100),
  };
}

async function getJson(url: string, fetcher: FetchLike) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`podcast directory ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function uniquePodcasts(rows: unknown[]) {
  const seen = new Set<string>();
  return rows
    .map((row) =>
      row && typeof row === 'object'
        ? normalizeItunesPodcast(row as Record<string, unknown>)
        : null,
    )
    .filter((podcast): podcast is Podcast => {
      if (!podcast || seen.has(podcast.id)) return false;
      seen.add(podcast.id);
      return true;
    });
}

export async function searchPodcasts(
  term: string,
  fetcher: FetchLike = fetch,
): Promise<{ outcome: Outcome; podcasts: Podcast[] }> {
  const params = new URLSearchParams({
    media: 'podcast',
    entity: 'podcast',
    term,
    limit: '25',
    country: COUNTRY,
  });
  const url = `${ITUNES}/search?${params.toString()}`;
  const hit = cached<{ outcome: Outcome; podcasts: Podcast[] }>(url);
  if (hit) return hit;
  try {
    const payload = await getJson(url, fetcher);
    const podcasts = uniquePodcasts(Array.isArray(payload.results) ? payload.results : []);
    const result = { outcome: podcasts.length ? 'results' : 'no_results', podcasts } as const;
    remember(url, result);
    return result;
  } catch {
    return { outcome: 'unavailable', podcasts: [] };
  }
}

export async function topPodcasts(
  fetcher: FetchLike = fetch,
): Promise<{ outcome: Outcome; podcasts: Podcast[] }> {
  const url = `${TOP_CHART}/${COUNTRY}/podcasts/top/25/podcasts.json`;
  const hit = cached<{ outcome: Outcome; podcasts: Podcast[] }>(url);
  if (hit) return hit;
  try {
    const payload = await getJson(url, fetcher);
    const feed = (payload.feed ?? {}) as Record<string, unknown>;
    const podcasts = uniquePodcasts(Array.isArray(feed.results) ? feed.results : []);
    if (podcasts.length === 0) throw new Error('empty chart');
    const result = { outcome: 'results', podcasts } as const;
    remember(url, result);
    return result;
  } catch {
    // The chart feed is optional: fall back to a directory search.
    return searchPodcasts('podcast italiano', fetcher);
  }
}

async function lookupPodcast(id: string, fetcher: FetchLike) {
  const url = `${ITUNES}/lookup?${new URLSearchParams({ id, entity: 'podcast', country: COUNTRY })}`;
  const payload = await getJson(url, fetcher);
  const raw = Array.isArray(payload.results)
    ? (payload.results[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!raw) return null;
  const podcast = normalizeItunesPodcast(raw);
  const feedUrl = httpsOrNull(raw.feedUrl);
  return podcast ? { podcast, feedUrl } : null;
}

// ---------- Feed RSS ----------

function isPrivateAddress(address: string) {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80')
    );
  }
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** Rifiuta URL non HTTPS o che puntano a reti private (protezione SSRF). */
export async function assertPublicHttpsUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((entry) => entry.address),
) {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('feed must use https');
  if (url.username || url.password) throw new Error('credentials not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    throw new Error('private host');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error('private host');
  return url;
}

async function readLimited(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchFeed(feedUrl: string, fetcher: FetchLike) {
  let current = feedUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    const url = await assertPublicHttpsUrl(current);
    const response = await fetcher(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect without location');
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`feed ${response.status}`);
    return readLimited(response);
  }
  throw new Error('too many redirects');
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeXmlText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#') {
        const point =
          code[1]?.toLowerCase() === 'x'
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : '';
      }
      return entities[code.toLowerCase()] ?? match;
    });
}

function plainText(value: string | null, max: number) {
  if (!value) return null;
  const decoded = decodeXmlText(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match) => decodeXmlText(match))
    .replace(/\s+/g, ' ')
    .trim();
  if (!decoded) return null;
  return decoded.length > max ? `${decoded.slice(0, max - 1).trimEnd()}…` : decoded;
}

function tagContent(xml: string, tag: string) {
  const escaped = tag.replace(':', '\\:');
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i').exec(xml);
  return match?.[1] ?? null;
}

function tagAttribute(xml: string, tag: string, attribute: string) {
  const escaped = tag.replace(':', '\\:');
  const element = new RegExp(`<${escaped}\\s[^>]*>`, 'i').exec(xml)?.[0];
  if (!element) return null;
  const value = new RegExp(`\\s${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(element);
  const raw = value?.[2] ?? value?.[3];
  return raw ? decodeXmlText(raw).trim() : null;
}

export function parseDuration(value: string | null) {
  if (!value) return null;
  const raw = decodeXmlText(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part)))
    return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function episodeKeyFor(identity: string) {
  return createHash('sha256').update(identity).digest('base64url').slice(0, 22);
}

export type ParsedEpisode = PodcastEpisode & { audioUrl: string };

/** Estrae gli episodi riproducibili (enclosure audio HTTPS) da un feed RSS podcast. */
export function parsePodcastFeed(xml: string): {
  artworkUrl: string | null;
  episodes: ParsedEpisode[];
} {
  const channelHead = xml.split(/<item[\s>]/i)[0] ?? '';
  const channelArt = httpsOrNull(tagAttribute(channelHead, 'itunes:image', 'href'));
  const episodes: ParsedEpisode[] = [];
  const seen = new Set<string>();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    if (episodes.length >= MAX_EPISODES) break;
    const audioUrl = httpsOrNull(tagAttribute(item, 'enclosure', 'url'));
    const type = tagAttribute(item, 'enclosure', 'type') ?? 'audio/mpeg';
    const title = plainText(tagContent(item, 'title'), 400);
    if (!audioUrl || !title || !type.toLowerCase().startsWith('audio/')) continue;
    const guid = plainText(tagContent(item, 'guid'), 500);
    const key = episodeKeyFor(guid ?? audioUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    const published = plainText(tagContent(item, 'pubDate'), 100);
    const publishedDate = published ? new Date(published) : null;
    const duration = parseDuration(tagContent(item, 'itunes:duration'));
    episodes.push({
      key,
      title,
      publishedAt:
        publishedDate && !Number.isNaN(publishedDate.valueOf())
          ? publishedDate.toISOString()
          : null,
      durationSeconds:
        duration !== null && duration >= 0 && duration <= 86_400 ? Math.floor(duration) : null,
      description: plainText(
        tagContent(item, 'itunes:summary') ?? tagContent(item, 'description'),
        600,
      ),
      artworkUrl: httpsOrNull(tagAttribute(item, 'itunes:image', 'href')),
      audioUrl,
    });
  }
  return { artworkUrl: channelArt, episodes };
}

export type PodcastDetail = {
  outcome: Outcome;
  podcast: Podcast | null;
  episodes: ParsedEpisode[];
};

export async function getPodcastDetail(
  id: string,
  fetcher: FetchLike = fetch,
): Promise<PodcastDetail> {
  if (!/^[0-9]{1,20}$/.test(id)) return { outcome: 'no_results', podcast: null, episodes: [] };
  const key = `detail:${id}`;
  const hit = cached<PodcastDetail>(key);
  if (hit) return hit;
  try {
    const found = await lookupPodcast(id, fetcher);
    if (!found) return { outcome: 'no_results', podcast: null, episodes: [] };
    if (!found.feedUrl) {
      return { outcome: 'no_results', podcast: found.podcast, episodes: [] };
    }
    const feed = parsePodcastFeed(await fetchFeed(found.feedUrl, fetcher));
    const podcast = {
      ...found.podcast,
      artworkUrl: found.podcast.artworkUrl ?? feed.artworkUrl,
    };
    const detail: PodcastDetail = {
      outcome: feed.episodes.length ? 'results' : 'no_results',
      podcast,
      episodes: feed.episodes,
    };
    remember(key, detail);
    return detail;
  } catch {
    return { outcome: 'unavailable', podcast: null, episodes: [] };
  }
}

export async function resolveEpisodeAudio(
  podcastId: string,
  episodeKey: string,
  fetcher: FetchLike = fetch,
) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(episodeKey)) return null;
  const detail = await getPodcastDetail(podcastId, fetcher);
  return detail.episodes.find((episode) => episode.key === episodeKey)?.audioUrl ?? null;
}
