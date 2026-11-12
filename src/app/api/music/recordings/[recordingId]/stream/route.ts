// @polsia:user-owned — stream di un brano registrato dall'utente. Serve il file privato
// solo al proprietario (controllo sulla riga del DB); /api/files resta negato per default.
import 'server-only';
import { NextResponse } from 'next/server';
import { getOwnedRecording, openRecordingStream } from '@/lib/music/recordings.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  Vary: 'Cookie, Range',
};

const recordingIdPattern = /^[a-z0-9]{20,36}$/;
const audioMimePattern = /^audio\/[a-z0-9][a-z0-9.+-]*$/;

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

async function signedIn(request: Request): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;

  const { recordingId } = await params;
  if (!recordingIdPattern.test(recordingId)) return jsonError('not_found', 404);

  const recording = await getOwnedRecording(auth.user.id, recordingId);
  if (!recording) return jsonError('not_found', 404);
  // Difesa in profondità: il MIME registrato deve restare audio.
  if (!audioMimePattern.test(recording.mimeType)) return jsonError('stream_unavailable', 502);

  const range = request.headers.get('range');
  const requested = range ? expectedRange(range, recording.byteLength) : null;
  if (range && !requested) return jsonError('invalid_range', 416);

  let upstream: Response;
  try {
    upstream = await openRecordingStream(recording.fileKey, range);
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
    contentLength === String(recording.byteLength);
  const partialResponse =
    range !== null &&
    requested !== null &&
    upstream.status === 206 &&
    rangeMatch !== null &&
    Number(rangeMatch[1]) === requested.start &&
    Number(rangeMatch[2]) === requested.end &&
    Number(rangeMatch[3]) === recording.byteLength &&
    contentLength === String(requested.end - requested.start + 1);

  if (
    !upstream.body ||
    contentType !== recording.mimeType.toLowerCase() ||
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
