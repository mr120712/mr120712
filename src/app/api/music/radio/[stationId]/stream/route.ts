// @polsia:user-owned — reindirizza il player allo stream HTTPS ufficiale della stazione.
import 'server-only';
import { NextResponse } from 'next/server';
import { currentUserHasPremium } from '@/lib/business/premium-access.server';
import { previewResponse } from '@/lib/music/preview-stream.server';
import { resolveStationStream } from '@/lib/music/radio-browser.server';

export const dynamic = 'force-dynamic';
// Live previews stream for ~30 s in real time.
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  const { stationId } = await params;
  const url = await resolveStationStream(stationId);
  if (!url) {
    return NextResponse.json({ error: 'station_unavailable' }, { status: 404 });
  }
  // Free listeners get a 30-second preview, enforced here; Premium streams the official source.
  if (!(await currentUserHasPremium())) return previewResponse(url);
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
