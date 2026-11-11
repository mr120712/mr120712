// @polsia:user-owned — reindirizza il player allo stream HTTPS ufficiale della stazione.
import 'server-only';
import { NextResponse } from 'next/server';
import { resolveStationStream } from '@/lib/music/radio-browser.server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  const { stationId } = await params;
  const url = await resolveStationStream(stationId);
  if (!url) {
    return NextResponse.json({ error: 'station_unavailable' }, { status: 404 });
  }
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
