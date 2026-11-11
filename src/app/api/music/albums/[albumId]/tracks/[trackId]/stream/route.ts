// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';
import { checkCurrentAudiusTrack } from '@/lib/music/current-catalog-track.server';
import { isVerifiedTrackPlayback, type TrackPlaybackResolution } from '@/lib/music/playback-policy';
import { resolveVerifiedTrackPlayback } from '@/lib/music/streaming-rights.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  Vary: 'Cookie, Range',
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

function discardBody(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

function expectedRange(range: string, byteLength: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, byteLength - suffixLength), end: byteLength - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : byteLength - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= byteLength
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, byteLength - 1) };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ albumId: string; trackId: string }> },
) {
  const { albumId, trackId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(albumId) || !/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) {
    return jsonError('track_unavailable', 404);
  }

  const access = await requireSolcoPro(request);
  if (!access.allowed) {
    const status = access.response.status;
    return jsonError(
      status === 401 ? 'unauthorized' : status === 403 ? 'pro_required' : 'entitlement_unavailable',
      status,
    );
  }

  const catalog = await checkCurrentAudiusTrack(albumId, trackId);
  if (catalog.state === 'unavailable') return jsonError('catalog_unavailable', 503);
  if (catalog.state !== 'current') return jsonError('track_unavailable', 404);

  const range = request.headers.get('range');
  let resolution: TrackPlaybackResolution;
  try {
    resolution = await resolveVerifiedTrackPlayback(albumId, trackId);
  } catch {
    return jsonError('rights_unavailable', 503);
  }
  if (!isVerifiedTrackPlayback(resolution, albumId, trackId))
    return jsonError('rights_unverified', 403);
  try {
    if (!(await resolution.checkSourceAvailable())) return jsonError('stream_unavailable', 502);
    if (!(await resolution.checkRightsEvidenceAvailable())) {
      return jsonError('rights_unverified', 403);
    }
  } catch {
    return jsonError('stream_unavailable', 503);
  }

  const requested = range ? expectedRange(range, resolution.source.byteLength) : null;
  if (range && !requested) return jsonError('invalid_range', 416);

  let upstream: Response;
  try {
    upstream = await resolution.openStream(range);
  } catch {
    return jsonError('stream_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const rangeMatch = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange) : null;
  const fullResponse =
    range === null &&
    upstream.status === 200 &&
    contentRange === null &&
    contentLength === String(resolution.source.byteLength);
  const partialResponse =
    range !== null &&
    requested !== null &&
    upstream.status === 206 &&
    rangeMatch !== null &&
    Number(rangeMatch[1]) === requested.start &&
    Number(rangeMatch[2]) === requested.end &&
    Number(rangeMatch[3]) === resolution.source.byteLength &&
    contentLength === String(requested.end - requested.start + 1);
  if (
    !upstream.body ||
    contentType !== resolution.source.mimeType ||
    (!fullResponse && !partialResponse)
  ) {
    discardBody(upstream);
    return jsonError('stream_unavailable', 502);
  }

  const headers = new Headers(privateHeaders);
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', contentLength as string);
  if (contentRange) headers.set('Content-Range', contentRange);
  return new Response(upstream.body, { status: upstream.status, headers });
}
