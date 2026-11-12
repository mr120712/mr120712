// @polsia:user-owned — stato pubblico dei controlli automatici (solo id dei controlli, nessun
// dettaglio). Letto ogni ora dal monitor esterno su GitHub Actions. Risponde subito con l'ultimo
// controllo salvato; se ha più di 50 minuti ne avvia uno nuovo dopo la risposta (after()), entro
// il limite globale 'monitor.run' (4 all'ora), così la risposta non aspetta mai i controlli.
import 'server-only';
import { NextResponse } from 'next/server';
import { type PublicMonitorStatus, PublicMonitorStatusSchema } from '@/lib/contracts/monitoring';
import { publicStatus } from '@/lib/monitoring/monitor.server';

export const dynamic = 'force-dynamic';
/**
 * The response never waits for a run, but the refresh scheduled with after() runs within this
 * same function limit (Next.js docs on after(), "Duration"): room for a database waking up plus
 * the checks (8 s each at most). Accepted on Vercel with Fluid compute (ai-search declares 120).
 */
export const maxDuration = 60;

const PUBLIC_CACHE = 'public, s-maxage=60, stale-while-revalidate=60';

const UNAVAILABLE: PublicMonitorStatus = {
  status: 'unknown',
  checkedAt: null,
  stale: true,
  failing: [],
  warnings: [],
};

export async function GET() {
  try {
    const status = PublicMonitorStatusSchema.parse(await publicStatus(new Date()));
    return NextResponse.json(status, {
      // No run yet: the first one is starting in the background, the next read must see it.
      headers: { 'Cache-Control': status.status === 'unknown' ? 'no-store' : PUBLIC_CACHE },
    });
  } catch (error) {
    // Database error or read deadline (PUBLIC_READ_DEADLINE_MS). 503, not 200 'unknown':
    // external monitors must notice that the status itself is broken. The log keeps the two
    // apart (PublicStatusDeadlineError or the Prisma error class).
    // biome-ignore lint/suspicious/noConsole: server log of the error name only (no details).
    console.warn('[monitor] status unavailable', error instanceof Error ? error.name : '?');
    return NextResponse.json(UNAVAILABLE, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
