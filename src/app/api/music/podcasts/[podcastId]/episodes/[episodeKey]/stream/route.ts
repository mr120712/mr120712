// @polsia:user-owned — reindirizza il player al file audio ufficiale dell'episodio (HTTPS).
import 'server-only';
import { NextResponse } from 'next/server';
import { resolveEpisodeAudio } from '@/lib/music/podcasts.server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ podcastId: string; episodeKey: string }> },
) {
  const { podcastId, episodeKey } = await params;
  const url = await resolveEpisodeAudio(podcastId, episodeKey);
  if (!url) return NextResponse.json({ error: 'episode_unavailable' }, { status: 404 });
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}
