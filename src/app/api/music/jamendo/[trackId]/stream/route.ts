// @polsia:user-owned — stream Jamendo (redirect al file ufficiale). Il catalogo è spento finché
// manca una licenza commerciale Jamendo (vedi src/lib/music/jamendo-license.ts): da spento risponde
// "not_configured" senza toccare il limite di ascolti.
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId, type PlayDecision } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { probeAudioUrl } from '@/lib/music/audio-probe.server';
import { resolveJamendoAudio } from '@/lib/music/jamendo.server';
import { jamendoEnabled } from '@/lib/music/jamendo-license';
import {
  checkStreamPlay,
  recordStreamPlay,
  willCountStreamPlay,
} from '@/lib/music/stream-play.server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  if (!jamendoEnabled()) {
    return NextResponse.json(
      { error: 'not_configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const { trackId } = await params;
  const qualifiedId = `jamendo:${trackId}`;
  if (!isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  }
  // Free accounts: 40 full plays a month (sign-in required); Premium is unlimited.
  // Checked before any audio, without writing: a failed track costs nothing.
  const play = await checkStreamPlay(qualifiedId);
  if (!play.decision.allowed) return playDeniedResponse(play.decision);
  const url = await resolveJamendoAudio(trackId);
  if (!url) return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  // A new Free play is recorded only once the Jamendo file really answers with audio.
  if (willCountStreamPlay(play) && !(await probeAudioUrl(url))) {
    return NextResponse.json({ error: 'stream_unavailable' }, { status: 502 });
  }
  let recorded: PlayDecision;
  try {
    recorded = await recordStreamPlay(play);
  } catch {
    return NextResponse.json({ error: 'stream_unavailable' }, { status: 503 });
  }
  if (!recorded.allowed) return playDeniedResponse(recorded);
  // Each counted play is the full track, in the background too (Free: 40 a month).
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
