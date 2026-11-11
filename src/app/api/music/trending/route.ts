// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicTrendingResponseSchema } from '@/lib/contracts/music';
import {
  getAudiusActivation,
  getAudiusAlbumReleases,
  getAudiusTrending,
} from '@/lib/music/audius-source.server';
import { sourceStatus } from '@/lib/music/source-policy';

export const dynamic = 'force-dynamic';

export async function GET() {
  const activation = getAudiusActivation();
  if (!activation.active) {
    const body = MusicTrendingResponseSchema.parse({
      outcome: 'unavailable',
      tracks: [],
      albums: [],
      sourceStatus: sourceStatus({
        id: 'audius',
        active: false,
        outcome: 'unavailable',
        blockers: activation.blockers,
        unavailableReason: 'not_configured',
      }),
    });
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  try {
    const [result, albumResult] = await Promise.all([
      getAudiusTrending(),
      getAudiusAlbumReleases(),
    ]);
    const hasTracks = result.tracks.length > 0;
    const hasAlbums = albumResult.albums.length > 0;
    const outcome =
      (result.outcome === 'unavailable' && hasAlbums) ||
      (albumResult.outcome === 'unavailable' && hasTracks)
        ? 'partial'
        : result.outcome === 'unavailable' && albumResult.outcome === 'unavailable'
          ? 'unavailable'
          : hasAlbums && !hasTracks
            ? 'results'
            : result.outcome === 'no_results' && albumResult.outcome === 'no_results'
              ? 'no_results'
              : result.outcome;
    const body = MusicTrendingResponseSchema.parse({
      outcome,
      tracks: result.tracks,
      albums: albumResult.albums,
      sourceStatus: sourceStatus({
        id: 'audius',
        active: true,
        outcome,
        ...('retryAfterSeconds' in result && result.retryAfterSeconds
          ? { retryAfterSeconds: result.retryAfterSeconds }
          : {}),
      }),
    });
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    const body = MusicTrendingResponseSchema.parse({
      outcome: 'unavailable',
      tracks: [],
      albums: [],
      sourceStatus: sourceStatus({ id: 'audius', active: true, outcome: 'unavailable' }),
    });
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  }
}
