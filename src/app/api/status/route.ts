// @polsia:user-owned — stato pubblico dei controlli automatici (solo id dei controlli, nessun
// dettaglio). Letto ogni ora dal monitor esterno su GitHub Actions. Se l'ultimo controllo ha più
// di 50 minuti ne avvia uno nuovo, entro il limite globale 'monitor.run' (4 all'ora).
import 'server-only';
import { NextResponse } from 'next/server';
import { type PublicMonitorStatus, PublicMonitorStatusSchema } from '@/lib/contracts/monitoring';
import { publicStatus } from '@/lib/monitoring/monitor.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' },
    });
  } catch {
    // 503, not 200 'unknown': external monitors must notice that the status itself is broken.
    return NextResponse.json(UNAVAILABLE, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
