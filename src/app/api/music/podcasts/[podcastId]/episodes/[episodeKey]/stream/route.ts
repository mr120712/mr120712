// @polsia:user-owned — reindirizza il player al file audio ufficiale dell'episodio (HTTPS).
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId } from '@/lib/business/play-quota';
import { consumePlayForCurrentUser, playDeniedResponse } from '@/lib/business/play-quota.server';
import { currentUserHasPremium } from '@/lib/business/premium-access.server';
import { resolveEpisodeAudio } from '@/lib/music/podcasts.server';
import { previewResponse } from '@/lib/music/preview-stream.server';

export const dynamic = 'force-dynamic';
// Live previews stream for ~30 s in real time.
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ podcastId: string; episodeKey: string }> },
) {
  const { podcastId, episodeKey } = await params;
  const qualifiedId = `podcast:${podcastId}~${episodeKey}`;
  if (!isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  }
  // Free accounts: 40 plays a month (sign-in required); Premium is unlimited.
  const play = await consumePlayForCurrentUser(qualifiedId);
  if (!play.allowed) return playDeniedResponse(play);
  const url = await resolveEpisodeAudio(podcastId, episodeKey);
  if (!url) return NextResponse.json({ error: 'episode_unavailable' }, { status: 404 });
  // Free listeners get a 30-second preview, enforced here; Premium streams the official source.
  if (!(await currentUserHasPremium())) return previewResponse(url);
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
