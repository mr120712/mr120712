// @polsia:user-owned — video YouTube di un brano importato, cercato al momento dell'ascolto.
import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { SongResolveResponseSchema } from '@/lib/contracts/library';
import { resolveSong } from '@/lib/music/song-resolve.server';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

const QuerySchema = z.object({
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().max(200).optional(),
});

export async function GET(request: Request) {
  // Searching spends YouTube quota: signed-in listeners only, same limits as search.
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json(
      { error: 'login_required', message: 'Accedi per ascoltare le playlist importate.' },
      { status: 401, headers: privateHeaders },
    );
  }
  const limited = await enforceRateLimit(
    'music.search',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return limited;

  const url = new URL(request.url);
  const query = QuerySchema.safeParse({
    title: url.searchParams.get('title') ?? '',
    artist: url.searchParams.get('artist') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: 'invalid_song' }, { status: 400, headers: privateHeaders });
  }

  const result = await resolveSong(query.data.title, query.data.artist || null);
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
