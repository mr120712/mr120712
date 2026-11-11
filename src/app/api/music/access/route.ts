// @polsia:user-owned — dice al player se l'utente ha ascolto completo e in background.
import 'server-only';
import { NextResponse } from 'next/server';
import { FREE_MONTHLY_PLAYS } from '@/lib/business/play-quota';
import { monthlyPlays } from '@/lib/business/play-quota.server';
import { currentAccess } from '@/lib/business/premium-access.server';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { premium, signedIn } = await currentAccess();
  const user = signedIn && !premium ? await getSessionUser().catch(() => null) : null;
  const playsUsed = user ? await monthlyPlays(user.id).catch(() => null) : null;
  return NextResponse.json(
    {
      premium,
      signedIn,
      // No previews any more: Free plays are full length (40 a month).
      previewSeconds: null,
      playsUsed,
      playsLimit: signedIn && !premium ? FREE_MONTHLY_PLAYS : null,
    },
    { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
  );
}
