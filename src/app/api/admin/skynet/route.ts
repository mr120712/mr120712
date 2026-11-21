// @polsia:user-owned — GET /api/admin/skynet: lo stato della sentinella «Skynet» per il pannello in
// Amministrazione → Monitoraggio. Solo amministratori con email verificata (controllo prima di
// qualsiasi accesso al database, come ogni API admin). Mai segreti nella risposta.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { SkynetOverviewSchema } from '@/lib/contracts/skynet';
import { skynetOverview } from '@/lib/skynet/sentinel.server';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return failure('unauthorized', 401);
    if (!isAuthorizedAdmin(session.user)) {
      return failure('forbidden', 403);
    }
  } catch {
    return failure('session_unavailable', 503);
  }
  try {
    const body = SkynetOverviewSchema.parse(await skynetOverview());
    return NextResponse.json(body, { headers: privateHeaders });
  } catch {
    return failure('skynet_unavailable', 503);
  }
}
