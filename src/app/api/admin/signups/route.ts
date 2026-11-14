// @polsia:user-owned — scheda Iscritti dell'amministratore (GET, sola lettura): totale account,
// nuovi nelle ultime 24 ore / 7 / 30 giorni, verificati, bloccati, amministratori, utenti Free e
// Pro (con i Pro per fonte, dai dati salvati) e iscrizioni per giorno degli ultimi 30 giorni (ora
// italiana). Solo numeri aggregati: nessun dato personale e nessun id utente.
// Solo admin con email verificata; il layout /admin protegge la pagina, questa route ricontrolla.
import 'server-only';
import { NextResponse } from 'next/server';
import { getSignupStats } from '@/lib/admin/signups.server';
import { auth } from '@/lib/auth';
import { AdminSignupsSchema } from '@/lib/contracts/admin-signups';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

export async function GET(request: Request) {
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;
  try {
    // Il parse `strict` del contratto rifiuta qualunque chiave non prevista prima della risposta.
    const body = AdminSignupsSchema.parse(await getSignupStats());
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (error) {
    // Solo il tipo di errore nei log: niente query, parametri o righe.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
    console.error(
      '[admin/signups] aggregazione non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('signups_unavailable', 500, {
      message: 'I dati sugli iscritti non sono disponibili in questo momento. Riprova tra poco.',
    });
  }
}
