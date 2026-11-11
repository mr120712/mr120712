// @polsia:user-owned — reindirizza il player allo stream HTTPS ufficiale della stazione.
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId } from '@/lib/business/play-quota';
import { consumePlayForCurrentUser, playDeniedResponse } from '@/lib/business/play-quota.server';
import { resolveStationStream } from '@/lib/music/radio-browser.server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  const { stationId } = await params;
  const qualifiedId = `radio:${stationId}`;
  if (!isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  }
  // Free accounts: 40 plays a month (sign-in required); Premium is unlimited.
  const play = await consumePlayForCurrentUser(qualifiedId);
  if (!play.allowed) return playDeniedResponse(play);
  const url = await resolveStationStream(stationId);
  if (!url) {
    return NextResponse.json({ error: 'station_unavailable' }, { status: 404 });
  }
  // Live radio is free and complete for everyone (in the background too).
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
