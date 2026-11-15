// @polsia:user-owned — POST /api/music/featured/offline-status: il dispositivo chiede, quando è
// online (in ogni pagina, se ha copie salvate: featured-offline-sync), quali COPIE OFFLINE di
// "brani in evidenza" salvate su di esso sono ancora consentite da diritti.json. Il corpo
// contiene SOLO gli id opachi (shareId) di quelle copie (al massimo 100),
// mai altri dati dei file sul dispositivo; la risposta dice quali sono ancora permessi e quali
// revocati (voce tolta o non valida, "offline": false, licenza "licenza" senza "offline": true,
// brano non più nello store, manifest assente o non valido: nel dubbio si esclude). Con l'elenco
// dello store incompleto (tetto di pagine) un id assente non è né permesso né revocato.
//
// - Same-origin (POST) e corpo validato con zod (400 con { errors }).
// - La sessione è FACOLTATIVA: anche un dispositivo da cui si è usciti deve togliere le copie
//   revocate. La risposta non rivela nulla di nuovo: gli id sono quelli dei link diretti pubblici e
//   il permesso è già nelle risposte della Home.
// - Limite per identità (utente o IP) con il bucket delle letture di catalogo (music.catalog), mai
//   quello dei download (la verifica non consuma i download del giorno).
// - Stesso indice in cache della ricerca (segue la versione del catalogo): una revoca arriva ai
//   dispositivi di solito entro ~30-90 secondi, al più ~6 minuti. Indice o store non leggibili →
//   503: il client tiene le copie (offline-first) e riprova più tardi.
// - Mai in cache (private, no-store).
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  FeaturedOfflineStatusRequestSchema,
  FeaturedOfflineStatusResponseSchema,
} from '@/lib/contracts/offline';
import { getFeaturedOfflineStatus } from '@/lib/music/featured-search.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  Vary: 'Cookie',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json({ error: 'forbidden_origin', message: 'Richiesta non consentita.' }, 403);
  }

  // Corpo prima di tutto: un corpo malformato non tocca né il limite né l'indice.
  const raw = await request.json().catch(() => null);
  const parsed = FeaturedOfflineStatusRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ errors: { ids: 'Elenco dei brani non valido (da 1 a 100 id).' } }, 400);
  }

  // La sessione è facoltativa: senza (o se non si riesce a verificarla) si limita per IP.
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const identity = getRateLimitIdentity(session?.user?.id ?? null, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.catalog', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const status = await getFeaturedOfflineStatus(parsed.data.ids);
  if (status.outcome !== 'ok') {
    return json(
      {
        error: 'unavailable',
        message: 'Non riesco a verificare i brani in evidenza adesso: riprovo più tardi.',
      },
      503,
    );
  }
  // Una forma inattesa non arriva mai al client.
  const body = FeaturedOfflineStatusResponseSchema.safeParse({
    permitted: status.permitted,
    revoked: status.revoked,
  });
  if (!body.success) return json({ error: 'unavailable' }, 503);
  return json(body.data);
}
