// @polsia:user-owned — elenco e ricerca di stazioni radio dal vivo (Radio Browser).
import 'server-only';
import { NextResponse } from 'next/server';
import { RadioListQuerySchema, RadioListResponseSchema } from '@/lib/contracts/library';
import { listStations } from '@/lib/music/radio-browser.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = RadioListQuerySchema.safeParse(params);
  if (!query.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }
  const result = await listStations({
    q: query.data.q || undefined,
    tag: query.data.tag || undefined,
    country: query.data.country || undefined,
    limit: query.data.limit,
  });
  return NextResponse.json(RadioListResponseSchema.parse(result), {
    headers: {
      'Cache-Control':
        result.outcome === 'unavailable' ? 'no-store' : 'public, max-age=300, s-maxage=600',
    },
  });
}
