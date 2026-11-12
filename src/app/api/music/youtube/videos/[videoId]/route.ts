// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { YouTubeVideoEligibilitySchema } from '@/lib/contracts/music';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { noteYouTubeQuotaExceeded, takeYouTubeUnits } from '@/lib/music/youtube-budget.server';
import { getYouTubeVideoDetails } from '@/lib/music/youtube-search.server';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };
// Dettagli confermati da YouTube: uguali per tutti, quindi la CDN li serve senza spendere quota.
const publicHeaders = {
  'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=3600',
};

export async function GET(request: Request, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return NextResponse.json(
      { error: 'invalid_video_id' },
      { status: 400, headers: privateHeaders },
    );
  }

  // Route anonima che spende quota YouTube: limite per IP d'ingresso (senza IP affidabile non limita).
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }

  // One quota unit per call, from a small share of the daily 1-unit budget (so this anonymous
  // route can never use up the units that keep saved searches re-checked), with a daily share
  // per IP on top of the catalogue limit.
  const apiKey = readYouTubeApiKey();
  if (apiKey && identity) {
    const share = await enforceRateLimit('music.youtube.details', identity);
    if (share) {
      for (const [name, value] of Object.entries(privateHeaders)) share.headers.set(name, value);
      return share;
    }
  }
  if (apiKey && !(await takeYouTubeUnits(1, { purpose: 'details' }))) {
    return NextResponse.json(
      YouTubeVideoEligibilitySchema.parse({
        videoId,
        eligibility: 'unknown',
        message: 'Le verifiche YouTube di oggi sono finite; il player non è stato caricato.',
      }),
      { headers: privateHeaders },
    );
  }
  const result = await getYouTubeVideoDetails(videoId, apiKey);
  if (result.outcome === 'quota_exceeded') await noteYouTubeQuotaExceeded('units');
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
      { headers: publicHeaders },
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
    { headers: publicHeaders },
  );
}
