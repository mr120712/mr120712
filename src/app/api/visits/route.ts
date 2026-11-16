// @polsia:user-owned — POST /api/visits: il segnale di visita del browser (src/components/custom/
// visit-beacon.tsx) per la scheda Visitatori dell'amministrazione. Stessa origine obbligatoria
// (nessun sito esterno può gonfiare i numeri), limite per IP, corpo piccolo e validato. Non scrive
// mai l'indirizzo IP né identificativi: vedi recordVisit. Risponde 204 senza corpo; il browser non
// aspetta la risposta.
import 'server-only';
import { NextResponse } from 'next/server';
import { recordVisit } from '@/lib/admin/visitors.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { SiteVisitBeaconSchema } from '@/lib/contracts/site-visit';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers: NO_STORE });
  }
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('site.visit', identity) : null;
  if (limited) return limited;

  const payload = await readJsonLimited(request, 4096);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = SiteVisitBeaconSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_visit' }, { status: 400, headers: NO_STORE });
  }
  try {
    await recordVisit({
      path: parsed.data.path,
      referrer: parsed.data.referrer,
      headers: request.headers,
    });
  } catch (error) {
    // Solo il tipo di errore nei log: niente percorsi, intestazioni o indirizzi.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
    console.error(
      '[visits] registrazione non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return NextResponse.json({ error: 'visit_unavailable' }, { status: 503, headers: NO_STORE });
  }
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
