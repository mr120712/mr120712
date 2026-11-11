// @polsia:user-owned — classifica dei video musicali più popolari su YouTube per paese.
import 'server-only';
import { NextResponse } from 'next/server';
import { YouTubeChartResponseSchema } from '@/lib/contracts/music';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { getYouTubeMusicChart } from '@/lib/music/youtube-search.server';

export const dynamic = 'force-dynamic';

const REGIONS = new Set(['IT', 'US', 'GB', 'FR', 'DE', 'ES', 'BR', 'JP', 'MX', 'IN', 'KR', 'NG']);

export async function GET(request: Request) {
  const requested = (new URL(request.url).searchParams.get('region') ?? 'IT').toUpperCase();
  const regionCode = REGIONS.has(requested) ? requested : 'IT';
  const result = await getYouTubeMusicChart(regionCode, readYouTubeApiKey());
  return NextResponse.json(YouTubeChartResponseSchema.parse({ ...result, regionCode }), {
    headers: {
      // One quota unit per refresh; the edge cache keeps traffic spikes off the API.
      'Cache-Control':
        result.outcome === 'unavailable'
          ? 'no-store'
          : 'public, max-age=900, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
