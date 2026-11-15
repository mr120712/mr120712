// @polsia:user-owned — GET /api/account/uid: l'UID leggibile del proprio account (es. SOL-7K2M-9QXD),
// mostrato nei «Dati dell'account» del profilo per l'assistenza. Lo assegna se manca (account nato
// dopo l'ultimo avvio del server). Serve la sessione; risposta privata, mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import { ensureAccountUid } from '@/lib/account/uid.server';
import { AccountUidResponseSchema } from '@/lib/contracts/account-admin';
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
  try {
    const uid = await ensureAccountUid(user.id);
    if (!uid) {
      return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: privateHeaders });
    }
    return NextResponse.json(AccountUidResponseSchema.parse({ uid }), { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: privateHeaders });
  }
}
