// @polsia:user-owned — GET /api/account/premium: se il proprio account è Premium e da quale fonte
// (Solco Pro, premio, abbonamento, in-app o Premium illimitato), per il badge «Premium» e la riga
// «Piano» del profilo. Stesse regole dell'ascolto (premiumAccessSource, fail closed). Serve la
// sessione; risposta privata, mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import { premiumAccessSource } from '@/lib/business/premium-access.server';
import { AccountPremiumResponseSchema } from '@/lib/contracts/account-premium';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (error) {
    return error instanceof Response && error.status === 401
      ? NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders })
      : NextResponse.json({ error: 'unavailable' }, { status: 503, headers: privateHeaders });
  }
  // premiumAccessSource non lancia: con un controllo non disponibile risponde null (Free).
  const source = await premiumAccessSource(user.id);
  return NextResponse.json(
    AccountPremiumResponseSchema.parse({ premium: source !== null, source }),
    {
      headers: privateHeaders,
    },
  );
}
