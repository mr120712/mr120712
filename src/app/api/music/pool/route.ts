// @polsia:user-owned — Record Pool: brani royalty-free scaricabili (Audius OML), per genere.
// Proxy anonimo di catalogo. Il download vero richiede login e passa dalla rotta Audius che
// riverifica la scaricabilità lato server.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { RecordPoolResponseSchema } from '@/lib/contracts/record-pool';
import { findRecordPoolGenre } from '@/lib/music/record-pool';
import { getRecordPool } from '@/lib/music/record-pool.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const rawGenre = (new URL(request.url).searchParams.get('genre') ?? '').trim().slice(0, 40);
  // Un genere non riconosciuto diventa "Tutti" (nessun errore): lo slug deve essere nel catalogo.
  const genreSlug = findRecordPoolGenre(rawGenre)?.slug ?? null;

  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  const result = await getRecordPool(genreSlug);
  return NextResponse.json(RecordPoolResponseSchema.parse(result), {
    headers: {
      'Cache-Control':
        result.outcome === 'unavailable' || result.outcome === 'inactive'
          ? 'no-store'
          : 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400',
    },
  });
}
