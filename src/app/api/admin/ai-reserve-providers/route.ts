// @polsia:user-owned — GET /api/admin/ai-reserve-providers: lo stato di ogni provider della riserva AI
// gratuita per il pannello in Amministrazione → Monitoraggio. Solo amministratori con email verificata
// (come ogni API admin). Mai segreti nella risposta (solo chiave presente/assente + HTTP della sonda).
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { reserveProvidersOverview } from '@/lib/business/ai-reserve-status.server';
import { ReserveProvidersOverviewSchema } from '@/lib/contracts/ai-reserve-providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return failure('unauthorized', 401);
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return failure('forbidden', 403);
    }
  } catch {
    return failure('session_unavailable', 503);
  }
  try {
    const body = ReserveProvidersOverviewSchema.parse(await reserveProvidersOverview());
    return NextResponse.json(body, { headers: privateHeaders });
  } catch {
    return failure('reserve_unavailable', 503);
  }
}
