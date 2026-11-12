// @polsia:user-owned — "Classici per decennio": costruisce playlist a tema dal catalogo Audius
// lecito (per genere/mood evocativi dell'epoca). Scoperta e ascolto; nessun download di master.
import 'server-only';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { getAudiusActivation, getAudiusMoodTracks } from '@/lib/music/audius-source.server';
import {
  CLASSICS_DECADES,
  type ClassicsDecade,
  type ClassicsPlaylistDef,
  findClassicsDecade,
} from '@/lib/music/classics';

const TRACKS_PER_PLAYLIST = 18;
const FETCH_LIMIT = 40;
const CACHE_TTL_MS = 15 * 60 * 1000;

export type ClassicsOutcome = 'results' | 'partial' | 'no_results' | 'unavailable' | 'inactive';
export type ClassicsPlaylistResult = {
  id: string;
  title: string;
  description: string;
  tracks: AudiusTrackSearchResult[];
};
export type ClassicsDecadeResult = {
  outcome: ClassicsOutcome;
  decade: string;
  label: string;
  tagline: string;
  playlists: ClassicsPlaylistResult[];
};

const cache = new Map<string, { expires: number; value: ClassicsDecadeResult }>();

function cached(key: string): ClassicsDecadeResult | undefined {
  const hit = cache.get(key);
  if (!hit || hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function remember(key: string, value: ClassicsDecadeResult) {
  if (cache.size >= 8) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

async function buildPlaylist(
  def: ClassicsPlaylistDef,
): Promise<{ playlist: ClassicsPlaylistResult; unavailable: boolean }> {
  const result = await getAudiusMoodTracks({
    moods: def.moods ?? [],
    genres: def.genres,
    limit: FETCH_LIMIT,
  });
  const unavailable = result.outcome === 'unavailable' || result.outcome === 'inactive';
  const seen = new Set<string>();
  const tracks: AudiusTrackSearchResult[] = [];
  for (const track of result.tracks) {
    if (!track.playbackEligible || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
    if (tracks.length >= TRACKS_PER_PLAYLIST) break;
  }
  return {
    playlist: { id: def.id, title: def.title, description: def.description, tracks },
    unavailable,
  };
}

export async function getClassicsDecade(decadeSlug?: string | null): Promise<ClassicsDecadeResult> {
  const decade: ClassicsDecade | undefined = findClassicsDecade(decadeSlug) ?? CLASSICS_DECADES[0];
  if (!decade) {
    return { outcome: 'no_results', decade: '60s', label: '', tagline: '', playlists: [] };
  }
  const base = {
    decade: decade.slug,
    label: decade.label,
    tagline: decade.tagline,
  };

  const activation = getAudiusActivation();
  if (!activation.active) return { outcome: 'inactive', ...base, playlists: [] };

  const hit = cached(decade.slug);
  if (hit) return hit;

  const built = await Promise.all(decade.playlists.map((def) => buildPlaylist(def)));
  const playlists = built.map((b) => b.playlist).filter((p) => p.tracks.length > 0);
  const anyUnavailable = built.some((b) => b.unavailable);

  let outcome: ClassicsOutcome;
  if (playlists.length > 0) outcome = anyUnavailable ? 'partial' : 'results';
  else if (anyUnavailable) outcome = 'unavailable';
  else outcome = 'no_results';

  const value: ClassicsDecadeResult = { outcome, ...base, playlists };
  // Non mettere in cache un risultato degradato (una playlist temporaneamente mancante):
  // altrimenti resterebbe parziale per tutti fino alla scadenza. 'partial' si ricalcola subito.
  if (outcome === 'results' || outcome === 'no_results') remember(decade.slug, value);
  return value;
}

export function clearClassicsCache() {
  cache.clear();
}
