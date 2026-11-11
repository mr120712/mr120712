// @polsia:user-owned — ricerca e brani popolari del catalogo Jamendo. Finché manca una licenza
// commerciale Jamendo il catalogo è spento e risponde subito { outcome: 'not_configured', tracks: [] }
// (prima del limite di richieste: un 429 non deve far comparire la sezione; vedi
// src/lib/music/jamendo-license.ts).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { JamendoListResponseSchema } from '@/lib/contracts/library';
import { listJamendoTracks } from '@/lib/music/jamendo.server';
import { jamendoEnabled } from '@/lib/music/jamendo-license';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!jamendoEnabled()) {
    return NextResponse.json(
      JamendoListResponseSchema.parse({ outcome: 'not_configured', tracks: [] }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').trim().slice(0, 80) || undefined;
  const tag = (params.get('tag') ?? '').trim().toLowerCase().slice(0, 40) || undefined;
  // Proxy anonimo: le ricerche uniche saltano la cache, quindi limite per IP d'ingresso
  // (senza un IP affidabile, come in sviluppo locale, non limita).
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;
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
