// @polsia:user-owned
import 'server-only';
import type { MusicSearchSource } from '@/lib/contracts/music';
import {
  getAudiusActivation,
  searchAudius,
  searchAudiusAlbums,
  searchAudiusPlaylists,
} from '@/lib/music/audius-source.server';
import { sourceStatus } from '@/lib/music/source-policy';
import { withYouTubeSearchBudget } from '@/lib/music/youtube-budget.server';
import {
  contractUnavailableReason,
  youtubeSearchNotice,
  youtubeShareOwner,
} from '@/lib/music/youtube-notice';
import { searchYouTubeMusic } from '@/lib/music/youtube-search.server';
import {
  createYouTubeSearchCache,
  YOUTUBE_SEARCH_CACHE_TTL_MS,
} from '@/lib/music/youtube-search-cache.server';
import {
  type StoredYouTubeSearch,
  storedYouTubeSearchWithTime,
} from '@/lib/music/youtube-search-store.server';

/** Videos returned to a listener's search (YouTube is always asked for 25 and they are saved). */
export const LISTENER_SEARCH_RESULTS = 10;

// Only current results are kept in memory: a saved (older) result or a blocked search depends on
// who is searching (their personal share), so it is worked out again for each request.
const youtubeSearchCache = createYouTubeSearchCache<StoredYouTubeSearch>({
  ttlMs: YOUTUBE_SEARCH_CACHE_TTL_MS,
  cacheable: (stored) => !stored.stale && stored.result.outcome !== 'unavailable',
});

export type MusicSource = 'audius' | 'youtube';

export function readYouTubeApiKey() {
  return process.env.YOUTUBE_DATA_API_KEY?.trim() ?? '';
}

export function getMusicSourceStatuses(
  outcomes: Partial<Record<MusicSource, MusicSearchSource['searchOutcome']>> = {},
) {
  const audius = getAudiusActivation();
  const youtubeApiKey = readYouTubeApiKey();
  return [
    sourceStatus({
      id: 'audius',
      active: audius.active,
      outcome: outcomes.audius,
      blockers: audius.blockers,
      ...(!audius.active ? { unavailableReason: 'not_configured' as const } : {}),
    }),
    sourceStatus({
      id: 'youtube',
      active: Boolean(youtubeApiKey),
      outcome: outcomes.youtube ?? (youtubeApiKey ? 'idle' : 'inactive'),
      youtubeConfigured: Boolean(youtubeApiKey),
      ...(!youtubeApiKey ? { unavailableReason: 'not_configured' as const } : {}),
    }),
  ] satisfies MusicSearchSource[];
}

/**
 * `youtubeIdentity` is the rate-limit identity of the person searching: YouTube searches that miss
 * the cache count against their daily share and the app-wide pool (see youtube-budget.server.ts).
 */
export async function searchMusic(
  source: MusicSource,
  query: string,
  options: { youtubeIdentity?: string | null } = {},
) {
  if (source === 'audius') {
    const activation = getAudiusActivation();
    if (!activation.active) {
      return {
        source,
        outcome: 'unavailable' as const,
        tracks: [],
        artists: [],
        playlists: [],
        albums: [],
        videos: [],
        sourceStatus: {
          ...getMusicSourceStatuses({ audius: 'unavailable' })[0],
          unavailableReason: 'not_configured' as const,
        },
      };
    }
    const [result, albumResult, playlistResult] = await Promise.all([
      searchAudius(query),
      searchAudiusAlbums(query),
      searchAudiusPlaylists(query),
    ]);
    const albumFailure = albumResult.outcome === 'unavailable';
    const playlistFailure = playlistResult.outcome === 'unavailable';
    const hasTracks = result.tracks.length > 0 || result.artists.length > 0;
    const hasAlbums = albumResult.albums.length > 0;
    const hasPlaylists = playlistResult.playlists.length > 0;
    const hasResults = hasTracks || hasAlbums || hasPlaylists;
    const outcome =
      ((albumFailure || playlistFailure) && hasResults) ||
      (result.outcome === 'unavailable' && (hasAlbums || hasPlaylists))
        ? 'partial'
        : result.outcome === 'unavailable' && albumFailure && playlistFailure
          ? 'unavailable'
          : hasResults
            ? 'results'
            : result.outcome === 'no_results' &&
                albumResult.outcome === 'no_results' &&
                playlistResult.outcome === 'no_results'
              ? 'no_results'
              : result.outcome;
    return {
      source,
      outcome,
      tracks: result.tracks,
      artists: result.artists,
      playlists: playlistResult.playlists,
      albums: albumResult.albums,
      videos: [],
      sourceStatus: getMusicSourceStatuses({ audius: outcome })[0],
    };
  }

  const apiKey = readYouTubeApiKey();
  if (!apiKey) {
    const status = getMusicSourceStatuses({ youtube: 'unavailable' })[1];
    return {
      source,
      outcome: 'unavailable' as const,
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
      videos: [],
      sourceStatus: { ...status, unavailableReason: 'not_configured' as const },
    };
  }
  const stored = await youtubeSearchCache.get(query, () =>
    storedYouTubeSearchWithTime(
      query,
      LISTENER_SEARCH_RESULTS,
      withYouTubeSearchBudget((term, size) => searchYouTubeMusic(term, apiKey, fetch, size), {
        identity: options.youtubeIdentity ?? null,
        purpose: 'listener',
      }),
    ),
  );
  const { result } = stored;
  const status = getMusicSourceStatuses({ youtube: result.outcome })[1];
  const unavailableReason = contractUnavailableReason(result.unavailableReason);
  return {
    source,
    outcome: result.outcome,
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: result.videos,
    sourceStatus: { ...status, ...(unavailableReason ? { unavailableReason } : {}) },
    youtube: youtubeSearchNotice(stored, new Date(), youtubeShareOwner(options.youtubeIdentity)),
  };
}

export function clearYouTubeSearchCacheForTests() {
  youtubeSearchCache.clear();
}
