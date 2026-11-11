// @polsia:user-owned — ricerca e classifica podcast (directory pubblica iTunes).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { PodcastListResponseSchema } from '@/lib/contracts/library';
import { searchPodcasts, topPodcasts } from '@/lib/music/podcasts.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const term = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 80);
  // Proxy anonimo: le ricerche uniche saltano la cache, quindi limite per IP d'ingresso
  // (senza un IP affidabile, come in sviluppo locale, non limita).
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;
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
