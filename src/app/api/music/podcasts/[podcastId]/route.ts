// @polsia:user-owned — scheda di un podcast con gli episodi dal feed RSS pubblico.
import 'server-only';
import { NextResponse } from 'next/server';
import { PodcastDetailResponseSchema } from '@/lib/contracts/library';
import { getPodcastDetail } from '@/lib/music/podcasts.server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ podcastId: string }> },
) {
  const { podcastId } = await params;
  const detail = await getPodcastDetail(podcastId);
  const body = PodcastDetailResponseSchema.parse({
    outcome: detail.outcome,
    podcast: detail.podcast,
    // The direct audio URL stays server-side: the player uses our redirect route.
    episodes: detail.episodes.map(({ audioUrl: _audioUrl, ...episode }) => episode),
  });
  return NextResponse.json(body, {
    status: detail.outcome === 'no_results' && !detail.podcast ? 404 : 200,
    headers: {
      'Cache-Control':
        detail.outcome === 'unavailable' ? 'no-store' : 'public, max-age=600, s-maxage=1800',
    },
  });
}
