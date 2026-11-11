// @polsia:user-owned — stream Jamendo, gratuito per tutti (redirect al file ufficiale).
import 'server-only';
import { NextResponse } from 'next/server';
import { currentUserHasPremium } from '@/lib/business/premium-access.server';
import { resolveJamendoAudio } from '@/lib/music/jamendo.server';
import { previewResponse } from '@/lib/music/preview-stream.server';

export const dynamic = 'force-dynamic';
// Live previews stream for ~30 s in real time.
export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  const url = await resolveJamendoAudio(trackId);
  if (!url) return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  // Free listeners get a 30-second preview, enforced here; Premium streams the official source.
  if (!(await currentUserHasPremium())) return previewResponse(url);
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
