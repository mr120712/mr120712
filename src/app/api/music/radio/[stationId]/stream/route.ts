// @polsia:user-owned — reindirizza il player allo stream HTTPS ufficiale della stazione.
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId, type PlayDecision } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { probeAudioUrl } from '@/lib/music/audio-probe.server';
import { resolveStationStream } from '@/lib/music/radio-browser.server';
import {
  checkStreamPlay,
  recordStreamPlay,
  willCountStreamPlay,
} from '@/lib/music/stream-play.server';

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
  // Sign-in required; whether radio counts toward the Free quota is decided by play-quota.
  // Checked before any audio, without writing: a dead station costs nothing.
  const play = await checkStreamPlay(qualifiedId);
  if (!play.decision.allowed) return playDeniedResponse(play.decision);
  const url = await resolveStationStream(stationId);
  if (!url) {
    return NextResponse.json({ error: 'station_unavailable' }, { status: 404 });
  }
  // A counted play is recorded only once the live stream really answers with audio.
  if (willCountStreamPlay(play) && !(await probeAudioUrl(url, { live: true }))) {
    return NextResponse.json({ error: 'stream_unavailable' }, { status: 502 });
  }
  let recorded: PlayDecision;
  try {
    recorded = await recordStreamPlay(play);
  } catch {
    return NextResponse.json({ error: 'stream_unavailable' }, { status: 503 });
  }
  if (!recorded.allowed) return playDeniedResponse(recorded);
  // Live radio is free and complete for everyone (in the background too).
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
