// @polsia:user-owned
import 'server-only';
import { mapAudiusAlbumDetail, normalizeAudiusAlbums } from '@/lib/music/audius';
import {
  AudiusApiError,
  createAudiusApiClient,
  readAudiusApiKey,
} from '@/lib/music/audius-api.server';
import type { SourceBlocker } from '@/lib/music/source-policy';
import { sourceStatus } from '@/lib/music/source-policy';

type AudiusSearchClient = ReturnType<typeof createAudiusApiClient>;

export type AudiusSearchResult = {
  tracks: Awaited<ReturnType<AudiusSearchClient['search']>>['tracks'];
  artists: Awaited<ReturnType<AudiusSearchClient['search']>>['artists'];
  outcome: 'inactive' | 'results' | 'no_results' | 'partial' | 'unavailable';
  retryAfterSeconds?: number;
};

export function getAudiusActivation(apiKey = readAudiusApiKey()) {
  const configuredKey = apiKey.trim();
  const blockers: SourceBlocker[] = configuredKey ? [] : ['credential_missing'];
  return { active: Boolean(configuredKey), blockers, apiKey: configuredKey };
}

export async function runAudiusSearch(
  term: string,
  active: boolean,
  client: Pick<AudiusSearchClient, 'search'>,
): Promise<AudiusSearchResult> {
  if (!active) return { tracks: [], artists: [], outcome: 'inactive' };
  try {
    return await client.search(term, active);
  } catch (error) {
    if (
      error instanceof AudiusApiError &&
      (error.kind === 'rate_limited' || error.kind === 'budget_exhausted')
    ) {
      return {
        tracks: [],
        artists: [],
        outcome: 'unavailable',
        retryAfterSeconds: error.retryAfterSeconds ?? undefined,
      };
    }
    return { tracks: [], artists: [], outcome: 'unavailable' };
  }
}

export async function searchAudius(term: string): Promise<AudiusSearchResult> {
  const activation = getAudiusActivation();
  if (!activation.active) return { tracks: [], artists: [], outcome: 'inactive' };
  const client = createAudiusApiClient({ apiKey: activation.apiKey });
  return runAudiusSearch(term, true, client);
}

export async function runAudiusTrending(
  active: boolean,
  client: Pick<AudiusSearchClient, 'trending'>,
) {
  if (!active) return { tracks: [], outcome: 'inactive' as const };
  try {
    return await client.trending(true);
  } catch (error) {
    if (
      error instanceof AudiusApiError &&
      (error.kind === 'rate_limited' || error.kind === 'budget_exhausted')
    ) {
      return {
        tracks: [],
        outcome: 'unavailable' as const,
        retryAfterSeconds: error.retryAfterSeconds ?? 1,
      };
    }
    return { tracks: [], outcome: 'unavailable' as const };
  }
}

export async function getAudiusTrending() {
  const activation = getAudiusActivation();
  if (!activation.active) return { tracks: [], outcome: 'inactive' as const };
  const client = createAudiusApiClient({ apiKey: activation.apiKey });
  return runAudiusTrending(true, client);
}

export async function searchAudiusAlbums(term: string) {
  const activation = getAudiusActivation();
  if (!activation.active) return { albums: [], outcome: 'inactive' as const };
  try {
    const payload = await createAudiusApiClient({ apiKey: activation.apiKey }).searchAlbums(term);
    const albums = normalizeAudiusAlbums(payload);
    return { albums, outcome: albums.length ? ('results' as const) : ('no_results' as const) };
  } catch (error) {
    return {
      albums: [],
      outcome: 'unavailable' as const,
      ...(error instanceof AudiusApiError && error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
}

export async function searchAudiusPlaylists(term: string) {
  const activation = getAudiusActivation();
  if (!activation.active) return { playlists: [], outcome: 'inactive' as const };
  try {
    const playlists = await createAudiusApiClient({ apiKey: activation.apiKey }).searchPlaylists(
      term,
    );
    return {
      playlists,
      outcome: playlists.length ? ('results' as const) : ('no_results' as const),
    };
  } catch (error) {
    return {
      playlists: [],
      outcome: 'unavailable' as const,
      ...(error instanceof AudiusApiError && error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
}

export async function getAudiusAlbumReleases() {
  const activation = getAudiusActivation();
  if (!activation.active) return { albums: [], outcome: 'inactive' as const };
  try {
    const payload = await createAudiusApiClient({ apiKey: activation.apiKey }).newReleases();
    const albums = normalizeAudiusAlbums(payload);
    return { albums, outcome: albums.length ? ('results' as const) : ('no_results' as const) };
  } catch (error) {
    return {
      albums: [],
      outcome: 'unavailable' as const,
      ...(error instanceof AudiusApiError && error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
}

export async function getAudiusHomeCatalog() {
  const activation = getAudiusActivation();
  if (!activation.active) {
    const inactiveStatus = sourceStatus({
      id: 'audius',
      active: false,
      outcome: 'unavailable',
      blockers: activation.blockers,
      unavailableReason: 'not_configured',
    });
    return {
      sourceStatus: inactiveStatus,
      trending: { outcome: 'unavailable' as const, tracks: [] },
      releases: { outcome: 'unavailable' as const, albums: [] },
      playlists: { outcome: 'unavailable' as const, playlists: [] },
      artists: { outcome: 'unavailable' as const, artists: [] },
    };
  }

  const client = createAudiusApiClient({ apiKey: activation.apiKey });
  const discoveryQuery = 'Electronic';
  const [trending, releases, playlists, artists] = await Promise.allSettled([
    client.trending(true),
    client.newReleases().then((payload) => normalizeAudiusAlbums(payload)),
    client.searchPlaylists(discoveryQuery),
    client.searchArtists(discoveryQuery),
  ]);

  const trendingSection =
    trending.status === 'fulfilled'
      ? {
          outcome:
            trending.value.outcome === 'inactive'
              ? ('unavailable' as const)
              : trending.value.outcome,
          tracks: trending.value.tracks,
        }
      : { outcome: 'unavailable' as const, tracks: [] };
  const releaseItems = releases.status === 'fulfilled' ? releases.value : [];
  const releaseSection = {
    outcome:
      releases.status === 'rejected'
        ? ('unavailable' as const)
        : releaseItems.length > 0
          ? ('results' as const)
          : ('no_results' as const),
    albums: releaseItems,
  };
  const playlistItems = playlists.status === 'fulfilled' ? playlists.value : [];
  const playlistSection = {
    outcome:
      playlists.status === 'rejected'
        ? ('unavailable' as const)
        : playlistItems.length > 0
          ? ('results' as const)
          : ('no_results' as const),
    playlists: playlistItems,
  };
  const artistItems = artists.status === 'fulfilled' ? artists.value : [];
  const artistSection = {
    outcome:
      artists.status === 'rejected'
        ? ('unavailable' as const)
        : artistItems.length > 0
          ? ('results' as const)
          : ('no_results' as const),
    artists: artistItems,
  };

  const outcomes = [
    trendingSection.outcome,
    releaseSection.outcome,
    playlistSection.outcome,
    artistSection.outcome,
  ];
  const hasResults =
    trendingSection.tracks.length > 0 ||
    releaseSection.albums.length > 0 ||
    playlistSection.playlists.length > 0 ||
    artistSection.artists.length > 0;
  const hasUnavailable = outcomes.includes('unavailable');
  const overallOutcome = hasResults
    ? hasUnavailable
      ? 'partial'
      : 'results'
    : hasUnavailable
      ? 'unavailable'
      : 'no_results';

  return {
    sourceStatus: sourceStatus({ id: 'audius', active: true, outcome: overallOutcome }),
    trending: trendingSection,
    releases: releaseSection,
    playlists: playlistSection,
    artists: artistSection,
  };
}

export async function getAudiusAlbumCatalogDetail(albumId: string) {
  const activation = getAudiusActivation();
  if (!activation.active)
    return { state: 'unavailable' as const, reason: 'source_inactive' as const };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(albumId)) {
    return { state: 'not_found' as const, reason: 'album_not_found' as const };
  }

  try {
    const client = createAudiusApiClient({ apiKey: activation.apiKey });
    const albumPayload = await client.getPlaylist(albumId);
    const albums = normalizeAudiusAlbums(albumPayload);
    if (!albums.some((album) => album.id === albumId)) {
      return { state: 'not_found' as const, reason: 'album_not_found' as const };
    }
    const tracksPayload = await client.getPlaylistTracks(albumId);
    const tracksData =
      typeof tracksPayload === 'object' &&
      tracksPayload !== null &&
      'data' in tracksPayload &&
      Array.isArray(tracksPayload.data);
    if (!tracksData) {
      return { state: 'unavailable' as const, reason: 'catalog_unavailable' as const };
    }
    const detail = mapAudiusAlbumDetail(albumPayload, tracksPayload, albumId, true);
    return detail
      ? { state: 'available' as const, ...detail }
      : { state: 'not_found' as const, reason: 'album_not_found' as const };
  } catch {
    return { state: 'unavailable' as const, reason: 'catalog_unavailable' as const };
  }
}
