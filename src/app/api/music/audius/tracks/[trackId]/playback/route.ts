// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  createAudiusPlaybackService,
  playbackFailureStatus,
} from '@/lib/music/audius-playback.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

function denied(reason: string, status: number) {
  return NextResponse.json({ allowed: false, reason }, { status, headers: privateHeaders });
}

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) return denied('track_not_found', 404);

  const service = createAudiusPlaybackService();
  if (!service.configured) return denied('source_inactive', 503);
  // Route anonima: limite per IP d'ingresso prima di usare la coda condivisa delle richieste Audius.
  // Senza un IP affidabile (sviluppo locale, test) non c'è un'identità da limitare.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }
  const verdict = await service.check(trackId);
  if (!verdict.allowed) return denied(verdict.reason, playbackFailureStatus(verdict.reason));
  return NextResponse.json({ allowed: true }, { headers: privateHeaders });
}
