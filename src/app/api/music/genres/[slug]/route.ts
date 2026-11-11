// @polsia:user-owned — brani YouTube per un genere o una playlist Solco (ricerca fissa, cache 24 h).
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicSearchResponseSchema } from '@/lib/contracts/music';
import { findGenre } from '@/lib/music/genre-catalog';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { searchYouTubeMusic } from '@/lib/music/youtube-search.server';
import { storedYouTubeSearch } from '@/lib/music/youtube-search-store.server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const genre = findGenre(slug);
  if (!genre) return NextResponse.json({ error: 'genre_not_found' }, { status: 404 });
  const result = await storedYouTubeSearch(genre.query, 25, () =>
    searchYouTubeMusic(genre.query, readYouTubeApiKey(), fetch, 25),
  );
  const body = {
    source: 'youtube' as const,
    outcome: result.outcome,
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: result.videos,
    sourceStatus: {
      id: 'youtube' as const,
      label: 'YouTube',
      active: result.outcome !== 'unavailable',
      searchOutcome: result.outcome,
      summary: 'Video musicali da YouTube.',
      prerequisite: 'YOUTUBE_DATA_API_KEY',
    },
  };
  return NextResponse.json(MusicSearchResponseSchema.parse(body), {
    headers: {
      // A YouTube search costs 100 quota units: one search per genre per day at most.
      'Cache-Control':
        result.outcome === 'unavailable'
          ? 'no-store'
          : result.outcome === 'no_results'
            ? // An empty genre page should not stay empty for a whole day.
              'public, max-age=600, s-maxage=3600'
            : 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=172800',
    },
  });
}
