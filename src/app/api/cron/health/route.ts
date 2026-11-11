// @polsia:user-owned — controllo automatico giornaliero (Vercel Cron, vedi vercel.json): esegue
// tutti i controlli interni e salva l'esito. Vercel invia "Authorization: Bearer <CRON_SECRET>";
// senza segreto valido risponde 401.
import 'server-only';
import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/business/cron-auth.server';
import { runMonitor } from '@/lib/monitoring/monitor.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }
  try {
    const run = await runMonitor('cron');
    const failing = run.results
      .filter((result) => result.status === 'fail')
      .map((result) => result.id);
    return NextResponse.json({ status: run.status, failing }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: 'monitor_failed' }, { status: 500, headers: noStore });
  }
}
