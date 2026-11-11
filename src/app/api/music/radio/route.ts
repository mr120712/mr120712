// @polsia:user-owned — elenco e ricerca di stazioni radio dal vivo (Radio Browser).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { RadioListQuerySchema, RadioListResponseSchema } from '@/lib/contracts/library';
import { listStations } from '@/lib/music/radio-browser.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = RadioListQuerySchema.safeParse(params);
  if (!query.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }
  // Proxy anonimo: le ricerche uniche saltano la cache, quindi limite per IP d'ingresso
  // (senza un IP affidabile, come in sviluppo locale, non limita).
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;
  const result = await listStations({
    q: query.data.q || undefined,
    tag: query.data.tag || undefined,
    country: query.data.country || undefined,
    limit: query.data.limit,
  });
  return NextResponse.json(RadioListResponseSchema.parse(result), {
    headers: {
      'Cache-Control':
        result.outcome === 'unavailable'
          ? 'no-store'
          : 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600',
    },
  });
}
