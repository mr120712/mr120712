// @polsia:user-owned — classifica dei video musicali più popolari su YouTube per paese.
// Salvata nel database per paese (2 ore, vedi youtube-chart-store.server.ts): parametri inventati
// nell'URL o regioni diverse della CDN non generano chiamate in più a YouTube. Limite per IP come
// gli altri proxy anonimi del catalogo.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { YouTubeChartResponseSchema } from '@/lib/contracts/music';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { storedYouTubeChart, YOUTUBE_CHART_STALE_MS } from '@/lib/music/youtube-chart-store.server';
import { getYouTubeMusicChart } from '@/lib/music/youtube-search.server';

export const dynamic = 'force-dynamic';

const REGIONS = new Set(['IT', 'US', 'GB', 'FR', 'DE', 'ES', 'BR', 'JP', 'MX', 'IN', 'KR', 'NG']);
/** A saved chart is kept at the edge 15 minutes: in its last 20 minutes it is not cached at all. */
const STALE_EDGE_MARGIN_MS = 20 * 60 * 1000;

export async function GET(request: Request) {
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) {
    limited.headers.set('Cache-Control', 'private, no-store');
    return limited;
  }
  const requested = (new URL(request.url).searchParams.get('region') ?? 'IT').toUpperCase();
  const regionCode = REGIONS.has(requested) ? requested : 'IT';
  const apiKey = readYouTubeApiKey();
  const { chart, stale, fetchedAt } = apiKey
    ? await storedYouTubeChart(regionCode, () => getYouTubeMusicChart(regionCode, apiKey))
    : { chart: { outcome: 'unavailable' as const, videos: [] }, stale: false, fetchedAt: null };
  // A saved chart is shown at most 24 h after YouTube sent it, edge copies included.
  const staleCacheable =
    fetchedAt !== null &&
    fetchedAt.getTime() + YOUTUBE_CHART_STALE_MS - Date.now() > STALE_EDGE_MARGIN_MS;
  return NextResponse.json(YouTubeChartResponseSchema.parse({ ...chart, regionCode }), {
    headers: {
      'Cache-Control':
        chart.outcome === 'unavailable' || (stale && !staleCacheable)
          ? 'no-store'
          : stale
            ? 'public, max-age=300, s-maxage=900'
            : // Short edge life: a chart shown as current stays within a few hours of YouTube.
              'public, max-age=900, s-maxage=3600, stale-while-revalidate=3600',
    },
  });
}
