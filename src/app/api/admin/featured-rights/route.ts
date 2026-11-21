// @polsia:user-owned — pagina admin «Diritti e testi» (GET, sola lettura): per ogni brano in
// evidenza dello store spiega perché è o non è ricercabile (diritti.json) e se il testo è
// disponibile per i brani dichiarati con "testo": true. È una DIAGNOSI: la risposta non contiene
// mai il testo di un brano (solo fonte, tipo e numero di righe) ed è validata dal contratto
// `strict` prima di uscire. Solo admin con email verificata; il layout /admin protegge la pagina,
// questa route ricontrolla.
import 'server-only';
import { NextResponse } from 'next/server';
import { buildFeaturedRightsReport } from '@/lib/admin/featured-rights-report.server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { AdminFeaturedRightsSchema } from '@/lib/contracts/admin-featured-rights';

export const dynamic = 'force-dynamic';
// Elenco dello store (≤ 8 s) + diritti.json (≤ 4 s) + controlli del testo (≤ 15 s).
export const maxDuration = 60;

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
    const body = AdminFeaturedRightsSchema.parse(await buildFeaturedRightsReport());
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (error) {
    // Solo il tipo di errore nei log: niente percorsi, voci del manifest o contenuti.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
    console.error(
      '[admin/featured-rights] diagnosi non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('featured_rights_unavailable', 500, {
      message:
        'La diagnosi di diritti e testi non è disponibile in questo momento. Riprova tra poco.',
    });
  }
}
