// @polsia:user-owned — ricerca e classifica podcast (directory pubblica iTunes).
import 'server-only';
import { NextResponse } from 'next/server';
import { PodcastListResponseSchema } from '@/lib/contracts/library';
import { searchPodcasts, topPodcasts } from '@/lib/music/podcasts.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const term = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 80);
  const result = term ? await searchPodcasts(term) : await topPodcasts();
  return NextResponse.json(PodcastListResponseSchema.parse(result), {
    headers: {
      'Cache-Control':
        result.outcome === 'unavailable'
          ? 'no-store'
          : 'public, max-age=600, s-maxage=1800, stale-while-revalidate=86400',
    },
  });
}
