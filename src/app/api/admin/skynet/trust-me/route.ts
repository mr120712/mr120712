// @polsia:user-owned — POST /api/admin/skynet/trust-me: l'amministratore verificato che apre /admin
// dichiara fidato il proprio indirizzo per 7 giorni (Skynet non lo manderà alla verifica, e al
// prossimo giro toglie quella che c'è). L'IP è quello che scrive Vercel (x-real-ip), mai il client.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';
import { isPublicIpLike } from '@/lib/skynet/hunter';
import { SKYNET_STATE_ID } from '@/lib/skynet/sentinel.server';
import { parseTrusted, trustIp } from '@/lib/skynet/trusted-ips';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers });
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return NextResponse.json({ error: 'session_unavailable' }, { status: 503, headers });
  }
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  if (!isAuthorizedAdmin(session.user)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
  }

  const ip = request.headers.get('x-real-ip')?.trim() ?? '';
  if (!ip || !isPublicIpLike(ip)) return NextResponse.json({ trusted: false }, { headers });

  const now = new Date();
  const row = await prisma.skynetState.findUnique({
    where: { id: SKYNET_STATE_ID },
    select: { trustedIps: true },
  });
  const { map, changed } = trustIp(parseTrusted(row?.trustedIps, now), ip, now);
  if (changed) {
    await prisma.skynetState.upsert({
      where: { id: SKYNET_STATE_ID },
      update: { trustedIps: map },
      create: { id: SKYNET_STATE_ID, updatedAt: now, streaks: {}, trustedIps: map },
    });
  }
  return NextResponse.json({ trusted: true, until: map[ip] ?? null }, { headers });
}
