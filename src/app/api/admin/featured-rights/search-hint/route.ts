// @polsia:user-owned — GET /api/admin/featured-rights/search-hint?q=…: l'avviso «Solo per admin» in
// cima ai risultati della ricerca. Dice se dei brani in evidenza corrispondono alla query ma la
// ricerca non li mostra perché non sono dichiarati in diritti.json (o perché diritti.json manca o
// non vale). Risponde SOLO con lo stato del manifest e due conteggi (contratto `strict`, validato
// prima di uscire): titoli e percorsi li elenca la pagina «Diritti e testi».
// Endpoint separato apposta: GET /api/music/search-all è cacheabile in CDN e condiviso fra tutti,
// quindi resta identico e non sa nulla di questo avviso. Qui invece: solo admin con email
// verificata (401/403/503 come GET /api/admin/featured-rights), risposte sempre `private,
// no-store` con `Vary: Cookie` (anche 400/401/403/429/500/503), la stessa validazione della query
// di search-all e lo stesso limite (bucket `music.search`, stessa identità `user:<id>`): nessun
// limite nuovo.
import 'server-only';
import { NextResponse } from 'next/server';
import { getFeaturedSearchHint } from '@/lib/admin/featured-search-hint.server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  ADMIN_SEARCH_HINT_QUERY_ERROR,
  AdminSearchHintQuerySchema,
  AdminSearchHintSchema,
} from '@/lib/contracts/admin-search-hint';

export const dynamic = 'force-dynamic';
// Elenco dello store (≤ 8 s) + diritti.json (≤ 4 s), in parallelo all'indice della ricerca (stessi
// tempi), al più una volta per finestra di cache (~5 minuti, ~1 minuto dopo un errore).
export const maxDuration = 20;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

function withPrivateHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

/** Stesso controllo della pagina «Diritti e testi»: sessione, ruolo admin ed email verificata. */
async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (!isAuthorizedAdmin(session.user)) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

export async function GET(request: Request) {
  // Prima il permesso: a chi non è admin non si dice nulla, nemmeno se la query è valida.
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  const parsed = AdminSearchHintQuerySchema.safeParse(
    new URL(request.url).searchParams.get('q') ?? '',
  );
  if (!parsed.success) {
    return NextResponse.json(
      { errors: { q: ADMIN_SEARCH_HINT_QUERY_ERROR } },
      { status: 400, headers: privateHeaders },
    );
  }

  // Lo stesso bucket e la stessa identità della ricerca unificata (che parte insieme a questa).
  const limited = await enforceRateLimit(
    'music.search',
    getRateLimitIdentity(access.userId, request.headers),
  );
  if (limited) return withPrivateHeaders(limited);

  try {
    // Il parse `strict` del contratto rifiuta qualunque chiave non prevista prima della risposta.
    const body = AdminSearchHintSchema.parse(await getFeaturedSearchHint(parsed.data));
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (error) {
    // Solo il tipo di errore nei log: niente query, titoli o percorsi.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
    console.error(
      '[admin/featured-rights/search-hint] avviso non riuscito:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('search_hint_unavailable', 500);
  }
}
