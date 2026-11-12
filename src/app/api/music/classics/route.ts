// @polsia:user-owned — "Classici per decennio": playlist curate dal catalogo Audius lecito.
// Proxy anonimo di catalogo. Nessun download di master: solo scoperta e ascolto on-demand.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { ClassicsResponseSchema } from '@/lib/contracts/classics';
import { findClassicsDecade } from '@/lib/music/classics';
import { getClassicsDecade } from '@/lib/music/classics.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const rawDecade = (new URL(request.url).searchParams.get('decade') ?? '').trim().slice(0, 10);
  const decadeSlug = findClassicsDecade(rawDecade)?.slug ?? null;

  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  const result = await getClassicsDecade(decadeSlug);
  return NextResponse.json(ClassicsResponseSchema.parse(result), {
    headers: {
      'Cache-Control':
        result.outcome === 'unavailable' ||
        result.outcome === 'inactive' ||
        result.outcome === 'partial'
          ? 'no-store'
          : 'public, max-age=600, s-maxage=1800, stale-while-revalidate=86400',
    },
  });
}
