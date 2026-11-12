// @polsia:user-owned — classifica community: i brani che gli utenti hanno pubblicato, per ascolti.
// Proxy anonimo (solo i brani pubblicati, mai i privati). L'ascolto richiede comunque il login.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { RecordingChartResponseSchema } from '@/lib/contracts/recordings';
import { listPublicRecordingsChart } from '@/lib/music/recordings.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  try {
    const items = await listPublicRecordingsChart();
    return NextResponse.json(RecordingChartResponseSchema.parse({ items }), {
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=120, stale-while-revalidate=600' },
    });
  } catch {
    return NextResponse.json(
      { items: [] },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
