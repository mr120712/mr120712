// @polsia:user-owned — catalogo Jamendo (musica indipendente in Creative Commons) per Premium.
// Richiede JAMENDO_CLIENT_ID (https://devportal.jamendo.com). Verificare i termini Jamendo
// per l'uso commerciale prima di vendere l'accesso.
import 'server-only';
import type { JamendoTrack } from '@/lib/contracts/library';

const API = 'https://api.jamendo.com/v3.0';
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 200;

type FetchLike = typeof fetch;
type Outcome = 'results' | 'no_results' | 'unavailable' | 'not_configured';
type Raw = Record<string, unknown>;

const cache = new Map<string, { expires: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit || hit.expires < Date.now()) {
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

export function clearJamendoCache() {
  cache.clear();
}

export function jamendoClientId() {
  return process.env.JAMENDO_CLIENT_ID?.trim() ?? '';
}

function text(value: unknown, max: number) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function https(value: unknown) {
  const raw = text(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeJamendoTrack(raw: Raw): (JamendoTrack & { audioUrl: string }) | null {
  const id = text(raw.id, 20);
  const title = text(raw.name, 300);
  const artist = text(raw.artist_name, 300);
  const audioUrl = https(raw.audio);
  if (!id || !/^[0-9]{1,20}$/.test(id) || !title || !artist || !audioUrl) return null;
  const duration =
    typeof raw.duration === 'number' && raw.duration > 0 ? Math.floor(raw.duration) : null;
  return {
    id,
    title,
    artistName: artist,
    albumName: text(raw.album_name, 300),
    artworkUrl: https(raw.album_image ?? raw.image),
    durationSeconds: duration,
    pageUrl: https(raw.shareurl),
    licenseUrl: https(raw.license_ccurl),
    audioUrl,
  };
}

async function request(params: Record<string, string>, fetcher: FetchLike) {
  const clientId = jamendoClientId();
  const query = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    audioformat: 'mp32',
    imagesize: '300',
    ...params,
  });
  const response = await fetcher(`${API}/tracks/?${query.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`jamendo ${response.status}`);
  const body = (await response.json()) as Raw;
  const headers = (body.headers ?? {}) as Raw;
  if (headers.status && headers.status !== 'success') throw new Error('jamendo error');
  const rows = Array.isArray(body.results) ? (body.results as Raw[]) : [];
  return rows.map(normalizeJamendoTrack).filter((track) => track !== null);
}

export async function listJamendoTracks(
  input: { q?: string; tag?: string },
  fetcher: FetchLike = fetch,
): Promise<{ outcome: Outcome; tracks: JamendoTrack[] }> {
  if (!jamendoClientId()) return { outcome: 'not_configured', tracks: [] };
  const params: Record<string, string> = { limit: '30' };
  if (input.q) params.search = input.q;
  if (input.tag) params.tags = input.tag;
  if (!input.q) params.order = 'popularity_week';
  const key = JSON.stringify(params);
  const hit = cached<{ outcome: Outcome; tracks: JamendoTrack[] }>(key);
  if (hit) return hit;
  try {
    const tracks = (await request(params, fetcher)).map(({ audioUrl: _audio, ...track }) => track);
    const result = { outcome: tracks.length ? 'results' : 'no_results', tracks } as const;
    remember(key, result);
    return result;
  } catch {
    return { outcome: 'unavailable', tracks: [] };
  }
}

export async function resolveJamendoAudio(trackId: string, fetcher: FetchLike = fetch) {
  if (!/^[0-9]{1,20}$/.test(trackId) || !jamendoClientId()) return null;
  const key = `audio:${trackId}`;
  const hit = cached<string | null>(key);
  if (hit !== undefined) return hit;
  try {
    const [track] = await request({ id: trackId }, fetcher);
    const url = track?.id === trackId ? track.audioUrl : null;
    remember(key, url);
    return url;
  } catch {
    return null;
  }
}
