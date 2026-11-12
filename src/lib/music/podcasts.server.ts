// @polsia:user-owned — podcast: ricerca e classifiche dalla directory pubblica iTunes,
// episodi dal feed RSS pubblico dello show. Gli episodi si ascoltano dal file audio ufficiale.
import 'server-only';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Podcast, PodcastEpisode } from '@/lib/contracts/library';
import { isPrivateAddress, ssrfSafeFetch } from '@/lib/net/ssrf-safe-fetch.server';

const ITUNES = 'https://itunes.apple.com';
const TOP_CHART = 'https://rss.applemarketingtools.com/api/v2';
const COUNTRY = 'it';
const TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 6 * 1024 * 1024;
const MAX_EPISODES = 100;
// Il feed è input non fidato: oltre al parsing lineare, tetto agli item esaminati
// (anche quelli scartati) e al tempo complessivo del parsing.
const MAX_ITEMS_SCANNED = 1000;
const PARSE_BUDGET_MS = 1000;
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
  if (url.port && url.port !== '443') throw new Error('port not allowed');
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

async function fetchFeed(feedUrl: string, fetcher: FetchLike = ssrfSafeFetch) {
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

// Tutte le scansioni del feed procedono solo in avanti (indexOf, oppure regex a lunghezza
// fissa con lastIndex): un feed ostile con migliaia di tag non chiusi resta lineare.

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Primo indice >= from in cui `pattern` (flag g, match a lunghezza fissa) trova un match, o -1. */
function indexOfPattern(source: string, pattern: RegExp, from: number) {
  pattern.lastIndex = from;
  return pattern.exec(source)?.index ?? -1;
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

function unwrapCdata(value: string) {
  let start = value.indexOf(CDATA_OPEN);
  if (start < 0) return value;
  const parts: string[] = [];
  let cursor = 0;
  while (start >= 0) {
    const end = value.indexOf(CDATA_CLOSE, start + CDATA_OPEN.length);
    // Nessuna chiusura dopo questa apertura: neanche le successive possono chiudersi.
    if (end < 0) break;
    parts.push(value.slice(cursor, start), value.slice(start + CDATA_OPEN.length, end));
    cursor = end + CDATA_CLOSE.length;
    start = value.indexOf(CDATA_OPEN, cursor);
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

export function decodeXmlText(value: string) {
  return unwrapCdata(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
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

/** Sostituisce ogni `<...>` con uno spazio; un `<` senza `>` successivo resta com'è. */
function stripTags(value: string) {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('<', cursor);
    if (open < 0) break;
    const close = value.indexOf('>', open + 1);
    if (close < 0) break;
    parts.push(value.slice(cursor, open), ' ');
    cursor = close + 1;
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

function plainText(value: string | null, max: number) {
  if (!value) return null;
  const decoded = stripTags(decodeXmlText(value))
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match) => decodeXmlText(match))
    .replace(/\s+/g, ' ')
    .trim();
  if (!decoded) return null;
  return decoded.length > max ? `${decoded.slice(0, max - 1).trimEnd()}…` : decoded;
}

function tagContent(xml: string, tag: string) {
  const name = escapeRegExp(tag);
  const start = indexOfPattern(xml, new RegExp(`<${name}[\\s>]`, 'gi'), 0);
  if (start < 0) return null;
  const open = xml.indexOf('>', start + tag.length + 1);
  if (open < 0) return null;
  const close = indexOfPattern(xml, new RegExp(`</${name}>`, 'gi'), open + 1);
  return close < 0 ? null : xml.slice(open + 1, close);
}

function tagAttribute(xml: string, tag: string, attribute: string) {
  const start = indexOfPattern(xml, new RegExp(`<${escapeRegExp(tag)}\\s`, 'gi'), 0);
  if (start < 0) return null;
  const end = xml.indexOf('>', start + tag.length + 2);
  if (end < 0) return null;
  const element = xml.slice(start, end + 1);
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

export type ParsedEpisode = PodcastEpisode & {
  audioUrl: string;
  /** URL del trascritto (tag podcast:transcript), risolto dal feed. Mai da un URL dell'utente. */
  transcriptUrl: string | null;
  transcriptType: string | null;
};

/** Estrae un attributo da un singolo elemento XML (es. un <podcast:transcript …>). */
function attrOf(element: string, attribute: string): string | null {
  const value = new RegExp(`\\s${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(element);
  const raw = value?.[2] ?? value?.[3];
  return raw ? decodeXmlText(raw).trim() : null;
}

// Formati temporizzati (json/vtt/srt) preferiti al testo semplice per la sincronizzazione.
const TRANSCRIPT_TYPE_PREFERENCE = [
  'application/json',
  'text/vtt',
  'application/x-subrip',
  'application/srt',
  'text/srt',
  'text/html',
  'text/plain',
];

/** Sceglie il miglior <podcast:transcript> dell'episodio (più formati possibili). */
function pickTranscript(item: string): { url: string; type: string } | null {
  const elements = item.match(/<podcast:transcript\b[^>]*>/gi);
  if (!elements) return null;
  let best: { url: string; type: string; rank: number } | null = null;
  for (const element of elements) {
    const url = httpsOrNull(attrOf(element, 'url'));
    if (!url) continue;
    const type = (attrOf(element, 'type') ?? 'text/plain').toLowerCase();
    const index = TRANSCRIPT_TYPE_PREFERENCE.indexOf(type);
    const rank = index < 0 ? TRANSCRIPT_TYPE_PREFERENCE.length : index;
    if (!best || rank < best.rank) best = { url, type, rank };
  }
  return best ? { url: best.url, type: best.type } : null;
}

function parseItem(item: string): ParsedEpisode | null {
  const audioUrl = httpsOrNull(tagAttribute(item, 'enclosure', 'url'));
  const type = tagAttribute(item, 'enclosure', 'type') ?? 'audio/mpeg';
  const title = plainText(tagContent(item, 'title'), 400);
  if (!audioUrl || !title || !type.toLowerCase().startsWith('audio/')) return null;
  const guid = plainText(tagContent(item, 'guid'), 500);
  const published = plainText(tagContent(item, 'pubDate'), 100);
  const publishedDate = published ? new Date(published) : null;
  const duration = parseDuration(tagContent(item, 'itunes:duration'));
  const transcript = pickTranscript(item);
  return {
    key: episodeKeyFor(guid ?? audioUrl),
    title,
    publishedAt:
      publishedDate && !Number.isNaN(publishedDate.valueOf()) ? publishedDate.toISOString() : null,
    durationSeconds:
      duration !== null && duration >= 0 && duration <= 86_400 ? Math.floor(duration) : null,
    description: plainText(
      tagContent(item, 'itunes:summary') ?? tagContent(item, 'description'),
      600,
    ),
    artworkUrl: httpsOrNull(tagAttribute(item, 'itunes:image', 'href')),
    hasTranscript: transcript !== null,
    audioUrl,
    transcriptUrl: transcript?.url ?? null,
    transcriptType: transcript?.type ?? null,
  };
}

const ITEM_OPEN = /<item[\s>]/gi;
const ITEM_OPEN_LENGTH = '<item>'.length;
const ITEM_CLOSE = /<\/item>/gi;
const ITEM_CLOSE_LENGTH = '</item>'.length;

/**
 * Estrae gli episodi riproducibili (enclosure audio HTTPS) da un feed RSS podcast.
 * Tempo lineare nella dimensione del feed, con tetto a dimensione, item esaminati e durata.
 */
export function parsePodcastFeed(xml: string): {
  artworkUrl: string | null;
  episodes: ParsedEpisode[];
} {
  const deadline = Date.now() + PARSE_BUDGET_MS;
  const source = xml.length > MAX_FEED_BYTES ? xml.slice(0, MAX_FEED_BYTES) : xml;
  const firstItem = indexOfPattern(source, ITEM_OPEN, 0);
  const channelHead = firstItem < 0 ? source : source.slice(0, firstItem);
  const channelArt = httpsOrNull(tagAttribute(channelHead, 'itunes:image', 'href'));
  const episodes: ParsedEpisode[] = [];
  const seen = new Set<string>();
  let cursor = firstItem;
  let scanned = 0;
  while (cursor >= 0 && episodes.length < MAX_EPISODES && scanned < MAX_ITEMS_SCANNED) {
    if (Date.now() > deadline) break;
    const close = indexOfPattern(source, ITEM_CLOSE, cursor + ITEM_OPEN_LENGTH);
    // Un item senza chiusura: nessun item successivo può chiudersi, il feed finisce qui.
    if (close < 0) break;
    const item = source.slice(cursor, close + ITEM_CLOSE_LENGTH);
    cursor = indexOfPattern(source, ITEM_OPEN, close + ITEM_CLOSE_LENGTH);
    scanned += 1;
    const episode = parseItem(item);
    if (!episode || seen.has(episode.key)) continue;
    seen.add(episode.key);
    episodes.push(episode);
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
    // Il feed è influenzato dall'utente (l'URL arriva dalla directory): fetcher con DNS pinning.
    const feed = parsePodcastFeed(await fetchFeed(found.feedUrl));
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
