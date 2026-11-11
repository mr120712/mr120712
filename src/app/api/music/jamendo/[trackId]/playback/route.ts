// @polsia:user-owned — verifica di riproduzione Jamendo. Il catalogo è spento finché manca una
// licenza commerciale Jamendo (vedi src/lib/music/jamendo-license.ts): da spento risponde
// "not_configured" e il player non avvia nulla.
import 'server-only';
import { NextResponse } from 'next/server';
import { jamendoEnabled } from '@/lib/music/jamendo-license';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  if (!jamendoEnabled()) {
    // `reason` drives the player's message ("brano non disponibile"); `error` names the cause.
    return NextResponse.json(
      { allowed: false, reason: 'track_unavailable', error: 'not_configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const { trackId } = await params;
  if (!/^[0-9]{1,20}$/.test(trackId)) {
    return NextResponse.json({ allowed: false, reason: 'track_unavailable' }, { status: 404 });
  }
  // Quota (Free: 40 plays a month, Premium unlimited) is enforced by the stream route.
  return NextResponse.json({ allowed: true }, { headers: { 'Cache-Control': 'no-store' } });
}
