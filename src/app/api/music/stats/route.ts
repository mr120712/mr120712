// @polsia:user-owned — statistiche di ascolto personali dell'utente autenticato (sola lettura).
import 'server-only';
import { NextResponse } from 'next/server';
import { getListeningStats } from '@/lib/music/listening-stats.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const stats = await getListeningStats(user.id);
  return NextResponse.json(
    { stats },
    { headers: { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' } },
  );
}
