// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  createAudiusPlaybackService,
  playbackFailureStatus,
} from '@/lib/music/audius-playback.server';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

const streamHeaders = {
  ...privateHeaders,
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  Vary: 'Range',
};

function validTrackId(trackId: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(trackId);
}

function errorResponse(error: string, status: number, retryAfterSeconds?: number) {
  return NextResponse.json(
    {
      error,
      reason: error,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
    { status, headers: streamHeaders },
  );
}

function rateLimitDetails(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'AudiusApiError') return null;
  if (!('kind' in error) || (error.kind !== 'rate_limited' && error.kind !== 'budget_exhausted')) {
    return null;
  }
  const retryAfterSeconds =
    'retryAfterSeconds' in error &&
    typeof error.retryAfterSeconds === 'number' &&
    error.retryAfterSeconds > 0
      ? error.retryAfterSeconds
      : undefined;
  return { retryAfterSeconds };
}

function validRange(range: string) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return false;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return false;
  if (!startText) {
    const suffix = Number(endText);
    return Number.isSafeInteger(suffix) && suffix > 0;
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : null;
  return (
    Number.isSafeInteger(start) &&
    start >= 0 &&
    (end === null || (Number.isSafeInteger(end) && end >= start))
  );
}

function isMatchingPartialResponse(range: string, contentRange: string | null) {
  const request = /^bytes=(\d*)-(\d*)$/.exec(range);
  const response = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange) : null;
  if (!request || !response) return false;

  const startText = request[1] ?? '';
  const endText = request[2] ?? '';
  const responseStart = Number(response[1]);
  const responseEnd = Number(response[2]);
  const totalText = response[3] ?? '*';
  const total = totalText === '*' ? null : Number(totalText);
  if (
    !Number.isSafeInteger(responseStart) ||
    !Number.isSafeInteger(responseEnd) ||
    responseStart < 0 ||
    responseEnd < responseStart ||
    (total !== null && (!Number.isSafeInteger(total) || responseEnd >= total))
  ) {
    return false;
  }

  if (startText) {
    const requestedStart = Number(startText);
    const requestedEnd = endText ? Number(endText) : null;
    return (
      responseStart === requestedStart && (requestedEnd === null || responseEnd <= requestedEnd)
    );
  }

  const suffixLength = Number(endText);
  return (
    total !== null &&
    suffixLength > 0 &&
    responseStart === Math.max(0, total - suffixLength) &&
    responseEnd === total - 1
  );
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

export async function getAudiusPlaybackResponse(trackId: string) {
  if (!validTrackId(trackId)) {
    return NextResponse.json(
      { allowed: false, reason: 'track_not_found' },
      { status: 404, headers: privateHeaders },
    );
  }

  const service = createAudiusPlaybackService();
  if (!service.configured) {
    return NextResponse.json(
      { allowed: false, reason: 'source_inactive' },
      { status: 503, headers: privateHeaders },
    );
  }

  try {
    const verdict = await service.check(trackId);
    if (!verdict.allowed) {
      return NextResponse.json(
        {
          allowed: false,
          reason: verdict.reason,
          ...(verdict.retryAfterSeconds ? { retryAfterSeconds: verdict.retryAfterSeconds } : {}),
        },
        { status: playbackFailureStatus(verdict.reason), headers: privateHeaders },
      );
    }
    return NextResponse.json({ allowed: true }, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { allowed: false, reason: 'state_unknown' },
      { status: 503, headers: privateHeaders },
    );
  }
}

export async function getAudiusStreamResponse(request: Request, trackId: string) {
  if (!validTrackId(trackId)) return errorResponse('track_not_found', 404);

  const range = request.headers.get('range');
  if (range && !validRange(range)) return errorResponse('invalid_range', 416);

  const service = createAudiusPlaybackService();
  if (!service.configured) return errorResponse('source_inactive', 503);

  let verdict: Awaited<ReturnType<typeof service.check>>;
  try {
    verdict = await service.check(trackId);
  } catch {
    return errorResponse('state_unknown', 503);
  }
  if (!verdict.allowed) {
    return errorResponse(verdict.reason, playbackFailureStatus(verdict.reason));
  }

  let upstream: Response;
  try {
    upstream = await service.streamTrack(trackId, range);
  } catch (error) {
    const rateLimit = rateLimitDetails(error);
    if (rateLimit) return errorResponse('rate_limited', 429, rateLimit.retryAfterSeconds);
    return errorResponse('stream_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentRange = upstream.headers.get('content-range');
  const matchingResponse = range
    ? upstream.status === 206 && isMatchingPartialResponse(range, contentRange)
    : upstream.status === 200 && contentRange === null;
  if (!upstream.body || !contentType?.startsWith('audio/') || !matchingResponse) {
    discard(upstream);
    return errorResponse('stream_unavailable', 502);
  }

  const headers = new Headers(streamHeaders);
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes');
  if (contentRange) headers.set('Content-Range', contentRange);
  const contentLength = upstream.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) headers.set('Content-Length', contentLength);
  return new Response(upstream.body, { status: upstream.status, headers });
}
