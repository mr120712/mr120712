// @polsia:user-owned — per un lotto di brani importati, trova (se esiste) una versione Audius
// scaricabile. Non scarica nulla: restituisce solo gli id Audius da passare alla rotta di download.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  DownloadableSourceRequestSchema,
  DownloadableSourceResponseSchema,
} from '@/lib/contracts/song-download';
import { resolveDownloadableAudiusTrack } from '@/lib/music/song-download-resolve.server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY_BYTES = 8 * 1024;
/** Oltre questo tempo i brani ancora non risolti tornano "nessuna" (riprovabili): niente timeout. */
const BUDGET_MS = 45_000;
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', privateHeaders['Cache-Control']);
  const vary = headers.get('Vary');
  headers.set('Vary', vary ? `${vary}, Cookie` : privateHeaders.Vary);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }

  let user: Awaited<ReturnType<typeof requireAuth>>;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return privateResponse(response as Response);
  }

  const limited = await enforceRateLimit(
    'music.resolve_download',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return privateResponse(limited);

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.status === 413
      ? privateResponse(limitedJsonError(body))
      : NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: privateHeaders });
  }

  const parsed = DownloadableSourceRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: privateHeaders },
    );
  }

  const started = Date.now();
  const results: Array<{ id: string; audiusTrackId: string | null }> = [];
  for (const song of parsed.data.songs) {
    if (Date.now() - started > BUDGET_MS) {
      results.push({ id: song.id, audiusTrackId: null });
      continue;
    }
    try {
      const resolution = await resolveDownloadableAudiusTrack(song.title, song.artist ?? null);
      results.push({ id: song.id, audiusTrackId: resolution.audiusTrackId });
    } catch {
      results.push({ id: song.id, audiusTrackId: null });
    }
  }

  return NextResponse.json(DownloadableSourceResponseSchema.parse({ results }), {
    headers: privateHeaders,
  });
}
