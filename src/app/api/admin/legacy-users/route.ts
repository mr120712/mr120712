// @polsia:user-owned — GET /api/admin/legacy-users («Controlla i database» in /admin/utenti-vecchi):
// trova i database indicati dalle variabili d'ambiente (elenco fisso), li raggruppa, segna «in
// uso» quello del sito e legge in SOLA LETTURA gli altri, solo adesso che l'admin lo chiede.
// Risponde con conteggi, nomi di variabili, impronte opache e categorie di errore: mai URL, host,
// email, hash o testo del driver. Solo admin con email verificata; risposta non memorizzabile.
import 'server-only';
import { NextResponse } from 'next/server';
import { diagnoseLegacyUsers } from '@/lib/admin/legacy-users.server';
import {
  failure,
  legacyFailureResponse,
  legacyRateLimit,
  privateHeaders,
  requireLegacyAdmin,
} from '@/lib/admin/legacy-users-route.server';
import { LegacyUsersDiagnosticSchema } from '@/lib/contracts/legacy-users';

export const dynamic = 'force-dynamic';
// Più database letti in parallelo, ognuno con una scadenza di 25 secondi.
export const maxDuration = 60;

export async function GET(request: Request) {
  const access = await requireLegacyAdmin(request);
  if (!access.allowed) return access.response;

  // Bucket admin esistente dei controlli manuali, con un'identità propria.
  const limited = await legacyRateLimit('monitor.run.admin', `legacy-users:user:${access.userId}`);
  if (limited) return limited;

  try {
    const result = await diagnoseLegacyUsers();
    if (!result.ok) return legacyFailureResponse(result.failure);
    // Il parse `strict` del contratto rifiuta qualunque chiave non prevista prima della risposta.
    const body = LegacyUsersDiagnosticSchema.parse(result.value);
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/legacy-users] controllo non riuscito:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure(
      'legacy_check_failed',
      500,
      'Il controllo dei database non è riuscito. Riprova tra poco.',
    );
  }
}
