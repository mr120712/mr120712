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
import {
  firstChunkUpstreamEnd,
  limitBody,
  parseStreamRange,
  planFirstChunk,
} from '@/lib/music/stream-first-chunk';
import {
  checkStreamPlay,
  recordStreamPlay,
  type StreamPlayCheck,
} from '@/lib/music/stream-play.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
};

type AudiusPlaybackService = ReturnType<typeof createAudiusPlaybackService>;

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

function discardBody(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

/** The upstream answer really carries audio: its media type and body, or null (body discarded). */
function upstreamAudio(upstream: Response) {
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    (upstream.status !== 200 && upstream.status !== 206) ||
    !upstream.body ||
    !contentType?.startsWith('audio/')
  ) {
    discardBody(upstream);
    return null;
  }
  return { contentType, body: upstream.body };
}

/**
 * Records the play now that audio is confirmed. Returns the refusal to send instead of the audio
 * (upstream body discarded), or null when the audio may go out. A seek/resume (Range) of a track
 * already counted within REPLAY_WINDOW_MS is not counted again.
 */
async function recordOrRefuse(play: StreamPlayCheck, upstream: Response) {
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
  return null;
}

function audioHeaders(contentType: string) {
  const headers = new Headers(privateHeaders);
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', 'inline');
  headers.set('Accept-Ranges', 'bytes');
  return headers;
}

/**
 * Range starting inside the first chunk (playback start, Safari's "bytes=0-1" probe, next-track
 * preload, or the resume of an interrupted preload such as "bytes=180000-"): bytes up to
 * FIRST_CHUNK_BYTES - 1 at most, whatever end the client asks for, and no play recorded, unless
 * that chunk is the whole file. Bytes past the chunk need a Range starting at FIRST_CHUNK_BYTES or
 * later, which counts.
 */
async function firstChunkResponse(
  service: AudiusPlaybackService,
  trackId: string,
  play: StreamPlayCheck,
  range: { start: number; end: number | null },
) {
  const { start } = range;
  const askedEnd = firstChunkUpstreamEnd(range.end);
  let upstream: Response;
  try {
    upstream = await service.streamTrack(trackId, `bytes=${start}-${askedEnd}`);
  } catch {
    return jsonError('stream_unavailable', 502);
  }
  const audio = upstreamAudio(upstream);
  if (!audio) return jsonError('stream_unavailable', 502);

  const plan = planFirstChunk({
    start,
    askedEnd,
    status: upstream.status,
    contentRange: upstream.headers.get('content-range'),
    contentLength: upstream.headers.get('content-length'),
  });
  // Unknown file size or a range not starting at `start`: no correct Content-Range and no way to
  // tell whether this chunk is the whole track. Fail closed: no audio, no play recorded.
  if (!plan) {
    discardBody(upstream);
    return jsonError('stream_unavailable', 502);
  }
  if (plan.wholeFile) {
    const refused = await recordOrRefuse(play, upstream);
    if (refused) return refused;
  }

  const length = plan.end - start + 1;
  const headers = audioHeaders(audio.contentType);
  headers.set('Content-Range', `bytes ${start}-${plan.end}/${plan.total}`);
  headers.set('Content-Length', String(length));
  return new Response(limitBody(audio.body, length, plan.skip), { status: 206, headers });
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
  // This also gates the free first chunk: guests and exhausted Free accounts get no byte at all.
  const play = await checkStreamPlay(`audius:${trackId}`);
  if (!play.decision.allowed) return playDeniedResponse(play.decision);
  // Fresh Audius verdict on every request, licence gate included (only the Open Music License).
  const verdict = await service.check(trackId);
  if (!verdict.allowed) return jsonError(verdict.reason, playbackFailureStatus(verdict.reason));

  const range = parseStreamRange(request.headers.get('range'));
  if (range.kind === 'first_chunk') return firstChunkResponse(service, trackId, play, range);

  // No Range (full body) or any other Range (continuation past the first chunk, seek past it,
  // suffix, multi-range): forwarded as asked, and the play is recorded once Audius has answered
  // with audio.
  let upstream: Response;
  try {
    upstream = await service.streamTrack(trackId, range.kind === 'forward' ? range.header : null);
  } catch {
    return jsonError('stream_unavailable', 502);
  }
  const audio = upstreamAudio(upstream);
  if (!audio) return jsonError('stream_unavailable', 502);

  const refused = await recordOrRefuse(play, upstream);
  if (refused) return refused;

  const headers = audioHeaders(audio.contentType);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) headers.set('Content-Length', contentLength);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange && /^bytes \d+-\d+\/(\d+|\*)$/.test(contentRange)) {
    headers.set('Content-Range', contentRange);
  }

  return new Response(audio.body, { status: upstream.status, headers });
}
