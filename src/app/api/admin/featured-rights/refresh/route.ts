// @polsia:user-owned — POST /api/admin/featured-rights/refresh: «Aggiorna ora» della pagina admin
// «Diritti e testi». Fa comparire subito ovunque (Home, ricerca, pagine d'artista, link diretti,
// testi) i brani aggiunti o tolti dal pannello Vercel Blob: incrementa il contatore condiviso del
// catalogo, svuota le cache di questa istanza e rielenca lo store (vedi
// featured-catalog-refresh.server). Solo admin con email verificata, stessa origine; limite
// 'monitor.run.admin' (lo stesso dei controlli manuali, contato a parte per questa azione):
// poche volte ogni 10 minuti, perché ogni pressione costa un elenco dello store per istanza.
// Nessun corpo richiesto; la risposta non va mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import { refreshFeaturedCatalogNow } from '@/lib/admin/featured-catalog-refresh.server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import { AdminFeaturedRefreshResponseSchema } from '@/lib/contracts/admin-featured-rights';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Contatore nel database + un elenco dello store (≤ 8 s).
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
    if (!isAuthorizedAdmin(session.user)) {
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

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  // Stesso bucket dei controlli manuali, ma con un'identità propria: i due conteggi non si sommano.
  const decision = await consumeRateLimit(
    'monitor.run.admin',
    `featured-refresh:user:${access.userId}`,
  );
  if (!decision.allowed) {
    const message =
      decision.status === 429
        ? `Hai già aggiornato i brani in evidenza più volte di recente. Riprova tra ${waitText(decision.retryAfterSeconds)}.`
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
    const body = AdminFeaturedRefreshResponseSchema.parse(await refreshFeaturedCatalogNow());
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (error) {
    // Solo il tipo di errore nei log: niente percorsi o dati.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/featured-rights/refresh] aggiornamento non riuscito:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('featured_refresh_failed', 503, {
      message: 'Non riesco ad aggiornare i brani in evidenza in questo momento. Riprova tra poco.',
    });
  }
}
