// @polsia:user-owned — «Potrebbe piacerti»: i brani consigliati dell'utente autenticato (sola
// lettura). Risposta PRIVATA (private, no-store, Vary: Cookie): mai in una cache condivisa o CDN,
// perché è calcolata dai suoi ascolti. ?page=N per «Altri consigli», ?personal=0 quando i consigli
// personalizzati sono spenti in Impostazioni (solo «Popolari su Solco»).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { RecommendationsQuerySchema } from '@/lib/contracts/recommendations';
import { getRecommendations } from '@/lib/music/recommendations.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';
/**
 * Above the slowest path (two Audius phases of at most 8 s each, plus the database), and room for
 * the once-a-day AI suggestions that run after the response (after(), same function limit).
 */
export const maxDuration = 60;

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: privateHeaders });
  }

  const url = new URL(request.url);
  const query = RecommendationsQuerySchema.safeParse({
    page: url.searchParams.get('page') ?? undefined,
    personal: url.searchParams.get('personal') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      { errors: { query: 'Richiesta dei consigli non valida.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  const limited = await enforceRateLimit('music.recommendations', `user:${user.id}`);
  if (limited) {
    limited.headers.set('Vary', 'Cookie');
    return limited;
  }

  try {
    const body = await getRecommendations(user.id, {
      page: query.data.page,
      personal: query.data.personal === '1',
    });
    return NextResponse.json(body, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'recommendations_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
