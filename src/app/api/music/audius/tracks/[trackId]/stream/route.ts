// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import type { PlayDecision } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  createAudiusPlaybackService,
  playbackFailureStatus,
} from '@/lib/music/audius-playback.server';
import { checkStreamPlay, recordStreamPlay } from '@/lib/music/stream-play.server';

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
  // Ogni richiesta (anche Range) costa due chiamate alla coda Audius condivisa: limite per IP
  // d'ingresso, prima di contare l'ascolto. Senza un IP affidabile (sviluppo locale, test) non limita.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }
  // Free accounts: 40 full plays a month (sign-in required); Premium is unlimited.
  // Checked before any Audius call or audio byte, without writing: a failed track costs nothing.
  const play = await checkStreamPlay(`audius:${trackId}`);
  if (!play.decision.allowed) return playDeniedResponse(play.decision);
  // Fresh Audius verdict on every request, licence gate included (only the Open Music License).
  const verdict = await service.check(trackId);
  if (!verdict.allowed) return jsonError(verdict.reason, playbackFailureStatus(verdict.reason));

  let upstream: Response;
  try {
    upstream = await service.streamTrack(trackId, request.headers.get('range'));
  } catch {
    return jsonError('stream_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    (upstream.status !== 200 && upstream.status !== 206) ||
    !upstream.body ||
    !contentType?.startsWith('audio/')
  ) {
    discardBody(upstream);
    return jsonError('stream_unavailable', 502);
  }

  // The audio really starts: only now is the play recorded. A seek/resume (Range) of a track
  // already counted within REPLAY_WINDOW_MS is not counted again.
  let recorded: PlayDecision;
  try {
    recorded = await recordStreamPlay(play);
  } catch {
    discardBody(upstream);
    return jsonError('stream_unavailable', 503);
  }
  if (!recorded.allowed) {
    discardBody(upstream);
    return playDeniedResponse(recorded);
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
