// @polsia:user-owned — «Skynet», la sentinella: ogni minuto (Vercel Cron, vedi vercel.json) legge
// anomalie di traffico e firewall su Vercel, /health da fuori e l'ultimo giro dei controlli
// interni, e avvisa gli amministratori su Telegram (src/lib/skynet/sentinel.server.ts). Solo
// lettura e avvisi. Vercel invia "Authorization: Bearer <CRON_SECRET>"; senza segreto valido 401.
import 'server-only';
import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/business/cron-auth.server';
import { runSentinel } from '@/lib/skynet/sentinel.server';

export const dynamic = 'force-dynamic';
/** Letture da Vercel (8 s), /health (10 s) e, solo in caso di incidente, il rapporto (25 s). */
export const maxDuration = 60;

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }
  try {
    return NextResponse.json(await runSentinel(), { headers: noStore });
  } catch {
    return NextResponse.json({ error: 'sentinel_failed' }, { status: 500, headers: noStore });
  }
}
