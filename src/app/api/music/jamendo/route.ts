// @polsia:user-owned — ricerca e brani popolari del catalogo Jamendo (riproduzione solo Premium).
import 'server-only';
import { NextResponse } from 'next/server';
import { JamendoListResponseSchema } from '@/lib/contracts/library';
import { listJamendoTracks } from '@/lib/music/jamendo.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').trim().slice(0, 80) || undefined;
  const tag = (params.get('tag') ?? '').trim().toLowerCase().slice(0, 40) || undefined;
  const result = await listJamendoTracks({ q, tag });
  return NextResponse.json(JamendoListResponseSchema.parse(result), {
    headers: {
      'Cache-Control':
        result.outcome === 'results' || result.outcome === 'no_results'
          ? 'public, max-age=600, s-maxage=1800, stale-while-revalidate=86400'
          : 'no-store',
    },
  });
}
