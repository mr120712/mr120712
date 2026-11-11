// @polsia:user-owned — stream Jamendo, gratuito per tutti (redirect al file ufficiale).
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId } from '@/lib/business/play-quota';
import { consumePlayForCurrentUser, playDeniedResponse } from '@/lib/business/play-quota.server';
import { resolveJamendoAudio } from '@/lib/music/jamendo.server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  const qualifiedId = `jamendo:${trackId}`;
  if (!isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  }
  // Free accounts: 40 full plays a month (sign-in required); Premium is unlimited.
  const play = await consumePlayForCurrentUser(qualifiedId);
  if (!play.allowed) return playDeniedResponse(play);
  const url = await resolveJamendoAudio(trackId);
  if (!url) return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  // Each counted play is the full track, in the background too (Free: 40 a month).
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
