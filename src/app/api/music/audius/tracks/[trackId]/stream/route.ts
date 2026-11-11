// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { consumePlayForCurrentUser, playDeniedResponse } from '@/lib/business/play-quota.server';
import {
  createAudiusPlaybackService,
  playbackFailureStatus,
} from '@/lib/music/audius-playback.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

function discardBody(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) return jsonError('track_not_found', 404);

  const service = createAudiusPlaybackService();
  if (!service.configured) return jsonError('source_inactive', 503);
  // Free accounts: 40 full plays a month (sign-in required); Premium is unlimited.
  // A replay of the same track within the replay window (and range requests) is not counted again.
  const play = await consumePlayForCurrentUser(`audius:${trackId}`);
  if (!play.allowed) return playDeniedResponse(play);
  const verdict = await service.check(trackId);
  if (!verdict.allowed) return jsonError(verdict.reason, playbackFailureStatus(verdict.reason));

  let upstream: Response;
  try {
    upstream = await service.streamTrack(trackId, request.headers.get('range'));
  } catch {
    return jsonError('stream_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!upstream.body || !contentType?.startsWith('audio/')) {
    discardBody(upstream);
    return jsonError('stream_unavailable', 502);
  }

  const headers = new Headers(privateHeaders);
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', 'inline');
  headers.set('Accept-Ranges', 'bytes');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) headers.set('Content-Length', contentLength);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange && /^bytes \d+-\d+\/(\d+|\*)$/.test(contentRange)) {
    headers.set('Content-Range', contentRange);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
