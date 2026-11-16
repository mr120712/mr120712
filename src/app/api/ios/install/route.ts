// @polsia:user-owned — stato dell'app iOS per chi è autenticato e, se c'è un IPA installabile, il
// link itms-services con un token a scadenza legato all'account (vedi ios-install.server). Serve una
// sessione (401 senza); limite per account contro chi volesse coniare token a raffica.
import 'server-only';
import { NextResponse } from 'next/server';
import { iosInstallStatusFor } from '@/lib/business/ios-install.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }
  const limited = await enforceRateLimit('ios.install.link', `user:${user.id}`);
  if (limited) return limited;
  const status = await iosInstallStatusFor(user.id);
  return NextResponse.json(status, { headers: { 'cache-control': 'private, no-store' } });
}
