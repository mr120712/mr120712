// @polsia:user-owned — reindirizza il player al file audio ufficiale dell'episodio (HTTPS).
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId, type PlayDecision } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { probeAudioUrl } from '@/lib/music/audio-probe.server';
import { resolveEpisodeAudio } from '@/lib/music/podcasts.server';
import {
  checkStreamPlay,
  recordStreamPlay,
  willCountStreamPlay,
} from '@/lib/music/stream-play.server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ podcastId: string; episodeKey: string }> },
) {
  const { podcastId, episodeKey } = await params;
  const qualifiedId = `podcast:${podcastId}~${episodeKey}`;
  if (!isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  }
  // Free accounts: 40 full plays a month (sign-in required); Premium is unlimited.
  // Checked before any audio, without writing: a failed episode costs nothing.
  const play = await checkStreamPlay(qualifiedId);
  if (!play.decision.allowed) return playDeniedResponse(play.decision);
  const url = await resolveEpisodeAudio(podcastId, episodeKey);
  if (!url) return NextResponse.json({ error: 'episode_unavailable' }, { status: 404 });
  // A new Free play is recorded only once the episode file really answers with audio.
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
