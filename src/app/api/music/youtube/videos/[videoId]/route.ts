// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { YouTubeVideoEligibilitySchema } from '@/lib/contracts/music';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { getYouTubeVideoDetails } from '@/lib/music/youtube-search.server';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

export async function GET(_request: Request, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json(
      { error: 'invalid_video_id' },
      { status: 400, headers: privateHeaders },
    );
  }

  const result = await getYouTubeVideoDetails(videoId, readYouTubeApiKey());
  if (result.outcome === 'not_configured') {
    return NextResponse.json(
      YouTubeVideoEligibilitySchema.parse({
        videoId,
        eligibility: 'unavailable',
        message: 'Manca il segreto server-side YOUTUBE_DATA_API_KEY.',
      }),
      { headers: privateHeaders },
    );
  }
  if (result.outcome === 'quota_exceeded') {
    return NextResponse.json(
      YouTubeVideoEligibilitySchema.parse({
        videoId,
        eligibility: 'unavailable',
        message: 'La quota YouTube Data API v3 è esaurita. Il player non è stato caricato.',
      }),
      { headers: privateHeaders },
    );
  }
  if (result.outcome !== 'found') {
    return NextResponse.json(
      YouTubeVideoEligibilitySchema.parse({
        videoId,
        eligibility: 'unavailable',
        message: 'YouTube non ha confermato questo video; il player non è stato caricato.',
      }),
      { headers: privateHeaders },
    );
  }
  if (result.details.madeForKids === true) {
    return NextResponse.json(
      YouTubeVideoEligibilitySchema.parse({
        videoId,
        eligibility: 'made_for_kids',
        message:
          'YouTube indica che questo video è destinato ai bambini; Solco non carica il player.',
        video: result.details.video,
      }),
      { headers: privateHeaders },
    );
  }
  if (result.details.madeForKids !== false) {
    return NextResponse.json(
      YouTubeVideoEligibilitySchema.parse({
        videoId,
        eligibility: 'unknown',
        message:
          'YouTube non ha fornito uno stato di audience verificabile; il player non è stato caricato.',
        video: result.details.video,
      }),
      { headers: privateHeaders },
    );
  }
  return NextResponse.json(
    YouTubeVideoEligibilitySchema.parse({
      videoId,
      eligibility: 'playable',
      message:
        'Apri il player ufficiale YouTube. I controlli, il branding e gli annunci restano gestiti da YouTube.',
      video: result.details.video,
    }),
    { headers: privateHeaders },
  );
}
