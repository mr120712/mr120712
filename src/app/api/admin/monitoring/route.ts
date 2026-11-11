// @polsia:user-owned — monitoraggio per l'amministratore: ultimo controllo con i dettagli,
// storico delle ultime 48 esecuzioni e battiti dei lavori pianificati (GET); "Controlla ora"
// avvia subito tutti i controlli (POST, limite 'monitor.run.admin'). Solo admin verificati.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import { AdminMonitoringSchema, AdminMonitorRunResponseSchema } from '@/lib/contracts/monitoring';
import {
  HISTORY_LIMIT,
  listHeartbeats,
  recentRuns,
  runMonitor,
  toRunSummary,
} from '@/lib/monitoring/monitor.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

function waitText(seconds: number) {
  if (seconds < 60) return seconds === 1 ? '1 secondo' : `${seconds} secondi`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minuto' : `${minutes} minuti`;
}

export async function GET(request: Request) {
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;
  try {
    const [runs, heartbeats] = await Promise.all([recentRuns(HISTORY_LIMIT), listHeartbeats()]);
    const body = AdminMonitoringSchema.parse({
      latest: runs[0] ?? null,
      history: runs.map(toRunSummary),
      heartbeats,
    });
    return NextResponse.json(body, { headers: privateHeaders });
  } catch {
    return failure('monitoring_unavailable', 503, {
      message: 'Lo storico dei controlli non è disponibile in questo momento.',
    });
  }
}

/** The request body is ignored: the run always covers every check. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  const decision = await consumeRateLimit('monitor.run.admin', `user:${access.userId}`);
  if (!decision.allowed) {
    const message =
      decision.status === 429
        ? `Hai già avviato diversi controlli di recente. Riprova tra ${waitText(decision.retryAfterSeconds)}.`
        : decision.message;
    return NextResponse.json(
      { error: decision.error, message, retryAfterSeconds: decision.retryAfterSeconds },
      {
        status: decision.status,
        headers: { ...privateHeaders, 'Retry-After': String(decision.retryAfterSeconds) },
      },
    );
  }

  try {
    const run = await runMonitor('admin');
    return NextResponse.json(AdminMonitorRunResponseSchema.parse({ run }), {
      headers: privateHeaders,
    });
  } catch {
    return failure('monitor_failed', 500, {
      message: 'Il controllo non è riuscito. Riprova tra qualche minuto.',
    });
  }
}
