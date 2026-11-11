// @polsia:user-owned — radio dal vivo tramite l'API pubblica Radio Browser (nessuna chiave richiesta).
// Solo stazioni con stream HTTPS: l'audio viene reindirizzato dal nostro dominio allo stream ufficiale.
import 'server-only';
import type { RadioStation } from '@/lib/contracts/library';

const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
];
const USER_AGENT = 'Solco/1.0 (music discovery)';
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

export type RadioQuery = { q?: string; tag?: string; country?: string; limit: number };
export type RadioResult = {
  outcome: 'results' | 'no_results' | 'unavailable';
  stations: RadioStation[];
};

type RawStation = Record<string, unknown>;
type FetchLike = typeof fetch;

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

export function clearRadioCache() {
  cache.clear();
}

function text(value: unknown, max: number) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
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

function count(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Normalizza una stazione Radio Browser; null se manca uno stream HTTPS o un ID valido. */
export function normalizeStation(raw: RawStation): RadioStation | null {
  const id = text(raw.stationuuid, 128);
  const name = text(raw.name, 200);
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !name) return null;
  if (!httpsOrNull(raw.url_resolved) && !httpsOrNull(raw.url)) return null;
  if (raw.lastcheckok === 0) return null;
  // HLS playlists don't play in a plain <audio> element outside Safari.
  const stream = stationStreamUrl(raw) ?? '';
  if (raw.hls === 1 || /\.m3u8(\?|$)/i.test(stream)) return null;
  const tags = (text(raw.tags, 400) ?? '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= 60)
    .slice(0, 12);
  const bitrate = count(raw.bitrate);
  return {
    id,
    name,
    artworkUrl: httpsOrNull(raw.favicon),
    country: text(raw.country, 100),
    countryCode: text(raw.countrycode, 4)?.toUpperCase() ?? null,
    tags,
    codec: text(raw.codec, 20),
    bitrate: bitrate > 0 ? bitrate : null,
    homepage: httpsOrNull(raw.homepage),
    votes: count(raw.votes),
  };
}

/** URL dello stream HTTPS della stazione (solo dopo normalizzazione riuscita). */
export function stationStreamUrl(raw: RawStation) {
  return httpsOrNull(raw.url_resolved) ?? httpsOrNull(raw.url);
}

async function requestJson(path: string, fetcher: FetchLike): Promise<unknown> {
  let lastError: unknown = null;
  for (const mirror of MIRRORS) {
    try {
      const response = await fetcher(`${mirror}${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!response.ok) {
        lastError = new Error(`Radio Browser ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Radio Browser non disponibile');
}

export function radioSearchPath(query: RadioQuery) {
  const params = new URLSearchParams({
    limit: String(query.limit),
    hidebroken: 'true',
    is_https: 'true',
    order: 'votes',
    reverse: 'true',
  });
  if (query.q) params.set('name', query.q);
  if (query.tag) {
    params.set('tag', query.tag.toLowerCase());
    params.set('tagExact', 'true');
  }
  if (query.country) params.set('countrycode', query.country.toUpperCase());
  return `/json/stations/search?${params.toString()}`;
}

export async function listStations(
  query: RadioQuery,
  fetcher: FetchLike = fetch,
): Promise<RadioResult> {
  const path = radioSearchPath(query);
  const hit = cached<RadioResult>(path);
  if (hit) return hit;
  try {
    const payload = await requestJson(path, fetcher);
    const rows = Array.isArray(payload) ? (payload as RawStation[]) : [];
    const seen = new Set<string>();
    const stations = rows.map(normalizeStation).filter((station): station is RadioStation => {
      if (!station || seen.has(station.id)) return false;
      seen.add(station.id);
      return true;
    });
    const result: RadioResult = {
      outcome: stations.length > 0 ? 'results' : 'no_results',
      stations,
    };
    remember(path, result);
    return result;
  } catch {
    return { outcome: 'unavailable', stations: [] };
  }
}

/** Risolve lo stream HTTPS di una stazione per UUID; null se assente o non sicuro. */
export async function resolveStationStream(stationId: string, fetcher: FetchLike = fetch) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(stationId)) return null;
  const key = `stream:${stationId}`;
  const hit = cached<string | null>(key);
  if (hit !== undefined) return hit;
  try {
    const payload = await requestJson(
      `/json/stations/byuuid/${encodeURIComponent(stationId)}`,
      fetcher,
    );
    const raw = Array.isArray(payload) ? (payload[0] as RawStation | undefined) : undefined;
    const url = raw && normalizeStation(raw) ? stationStreamUrl(raw) : null;
    remember(key, url);
    return url;
  } catch {
    return null;
  }
}
