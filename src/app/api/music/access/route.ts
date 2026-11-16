// @polsia:user-owned — dice al player se l'utente ha ascolto completo e in background.
import 'server-only';
import { NextResponse } from 'next/server';
import { FEATURED_FREE_MONTHLY_PLAYS, FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import { monthlyFeaturedPlays, monthlyPlays } from '@/lib/business/play-quota.server';
import { currentAccess } from '@/lib/business/premium-access.server';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { premium, signedIn } = await currentAccess();
  const user = signedIn && !premium ? await getSessionUser().catch(() => null) : null;
  // Due conteggi Free separati: il catalogo (Audius, podcast, audio.com: 40) e i brani in evidenza
  // della Home (30 avvii). Un conteggio non letto (database giù) resta null: il player non prevede.
  const [playsUsed, featuredPlaysUsed] = user
    ? await Promise.all([
        monthlyPlays(user.id).catch(() => null),
        monthlyFeaturedPlays(user.id).catch(() => null),
      ])
    : [null, null];
  const free = signedIn && !premium;
  return NextResponse.json(
    {
      premium,
      signedIn,
      // No previews any more: Free plays are full length (40 a month).
      previewSeconds: null,
      playsUsed,
      playsLimit: free ? FREE_MONTHLY_PLAYS : null,
      featuredPlaysUsed,
      featuredPlaysLimit: free ? FEATURED_FREE_MONTHLY_PLAYS : null,
    },
    { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
  );
}
