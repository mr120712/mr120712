// @polsia:user-owned — video YouTube di un brano importato, cercato al momento dell'ascolto.
// GET: cache condivisa prima, poi (con limiti dedicati) la ricerca su YouTube.
// POST: il video scelto non si riproduce → dimentica quella scelta.
import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { SongResolveResponseSchema } from '@/lib/contracts/library';
import {
  invalidateSongResolution,
  peekSongResolution,
  searchSong,
} from '@/lib/music/song-resolve.server';
import { getSessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

const SongSchema = z.object({
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().max(200).optional(),
});

function loginRequired() {
  return NextResponse.json(
    { error: 'login_required', message: 'Accedi per ascoltare le playlist importate.' },
    { status: 401, headers: privateHeaders },
  );
}

export async function GET(request: Request) {
  const user = await getSessionUser().catch(() => null);
  if (!user) return loginRequired();

  const url = new URL(request.url);
  const query = SongSchema.safeParse({
    title: url.searchParams.get('title') ?? '',
    artist: url.searchParams.get('artist') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: 'invalid_song' }, { status: 400, headers: privateHeaders });
  }
  const artist = query.data.artist || null;

  // Already known (found or not found): costs nothing, no limit.
  const cached = await peekSongResolution(query.data.title, artist);
  if (cached?.ok) {
    return NextResponse.json(SongResolveResponseSchema.parse({ video: cached.video }), {
      headers: privateHeaders,
    });
  }

  // A real YouTube search: per-listener and app-wide daily caps protect the shared quota.
  const limited =
    (await enforceRateLimit(
      'music.resolve_song',
      getRateLimitIdentity(user.id, request.headers),
    )) ?? (await enforceRateLimit('music.resolve_song.global', 'global'));
  if (limited) return limited;

  const result = await searchSong(query.data.title, artist);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: 'unavailable',
        message: 'YouTube non è disponibile in questo momento. Riprova più tardi.',
      },
      { status: 503, headers: privateHeaders },
    );
  }
  return NextResponse.json(SongResolveResponseSchema.parse({ video: result.video }), {
    headers: privateHeaders,
  });
}

const InvalidateSchema = SongSchema.extend({ videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/) });

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const user = await getSessionUser().catch(() => null);
  if (!user) return loginRequired();
  const limited = await enforceRateLimit(
    'music.resolve_song',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return limited;
  const payload = await readJsonLimited(request, 2 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = InvalidateSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_song' }, { status: 400, headers: privateHeaders });
  }
  await invalidateSongResolution(body.data.title, body.data.artist || null, body.data.videoId);
  return NextResponse.json({ invalidated: true }, { headers: privateHeaders });
}
