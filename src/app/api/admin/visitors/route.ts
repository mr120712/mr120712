// @polsia:user-owned — scheda Visitatori dell'amministratore (GET, sola lettura): visitatori e
// pagine aperte di oggi, degli ultimi 7 e 30 giorni, andamento per giorno (ora italiana), pagine
// più viste, Paesi, siti di provenienza e dispositivi. Solo numeri aggregati: nessun indirizzo IP,
// nessuna impronta, nessun indirizzo di provenienza intero.
// Solo admin con email verificata; il layout /admin protegge la pagina, questa route ricontrolla.
import 'server-only';
import { NextResponse } from 'next/server';
import { getVisitorStats } from '@/lib/admin/visitors.server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { AdminVisitorsSchema } from '@/lib/contracts/admin-visitors';

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
    if (!isAuthorizedAdmin(session.user)) {
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
    const body = AdminVisitorsSchema.parse(await getVisitorStats());
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (error) {
    // Solo il tipo di errore nei log: niente query, parametri o righe.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
    console.error(
      '[admin/visitors] aggregazione non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('visitors_unavailable', 500, {
      message: 'I dati sui visitatori non sono disponibili in questo momento. Riprova tra poco.',
    });
  }
}
