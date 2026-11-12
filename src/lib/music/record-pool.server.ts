// @polsia:user-owned — Record Pool: un feed di brani royalty-free che l'artista ha reso
// SCARICABILI su Audius (Open Music License). Si riproducono e si scaricano dentro Solco con
// l'infrastruttura di download lecita esistente (la rotta riverifica la scaricabilità lato server).
import 'server-only';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { getAudiusActivation, getAudiusMoodTracks } from '@/lib/music/audius-source.server';
import { findRecordPoolGenre, RECORD_POOL_ALL_GENRES } from '@/lib/music/record-pool';

const MAX_TRACKS = 48;
const FETCH_LIMIT = 100;
const CACHE_TTL_MS = 15 * 60 * 1000;

export type RecordPoolOutcome = 'results' | 'no_results' | 'unavailable' | 'inactive';
export type RecordPoolResult = {
  outcome: RecordPoolOutcome;
  genre: string | null;
  tracks: AudiusTrackSearchResult[];
};

const cache = new Map<string, { expires: number; value: RecordPoolResult }>();

function cached(key: string): RecordPoolResult | undefined {
  const hit = cache.get(key);
  if (!hit || hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function remember(key: string, value: RecordPoolResult) {
  if (cache.size >= 40) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

/** Brani scaricabili e riproducibili, deduplicati e con un tetto. */
function pickDownloadable(tracks: AudiusTrackSearchResult[]): AudiusTrackSearchResult[] {
  const seen = new Set<string>();
  const out: AudiusTrackSearchResult[] = [];
  for (const track of tracks) {
    if (track.downloadable !== true || !track.playbackEligible) continue;
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
    if (out.length >= MAX_TRACKS) break;
  }
  return out;
}

export async function getRecordPool(genreSlug?: string | null): Promise<RecordPoolResult> {
  const genre = findRecordPoolGenre(genreSlug);
  const key = genre ? genre.slug : 'all';

  const activation = getAudiusActivation();
  if (!activation.active) return { outcome: 'inactive', genre: genre?.slug ?? null, tracks: [] };

  const hit = cached(key);
  if (hit) return hit;

  const genres = genre ? [genre.audius] : RECORD_POOL_ALL_GENRES;
  const result = await getAudiusMoodTracks({ moods: [], genres, limit: FETCH_LIMIT });

  if (result.outcome === 'unavailable' || result.outcome === 'inactive') {
    // Non mettere in cache un errore: riprova alla prossima richiesta.
    return {
      outcome: result.outcome === 'inactive' ? 'inactive' : 'unavailable',
      genre: genre?.slug ?? null,
      tracks: [],
    };
  }

  const tracks = pickDownloadable(result.tracks);
  const value: RecordPoolResult = {
    outcome: tracks.length > 0 ? 'results' : 'no_results',
    genre: genre?.slug ?? null,
    tracks,
  };
  remember(key, value);
  return value;
}

export function clearRecordPoolCache() {
  cache.clear();
}
