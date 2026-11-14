// @polsia:user-owned — contatore PUBBLICO degli iscritti per la landing (GET, senza login): totale
// degli account non bloccati e nuovi negli ultimi 7 giorni. Solo numeri aggregati, nessun dato
// personale; il dettaglio (bloccati, admin, verificati, grafico per giorno) resta in /admin.
// Il carico sul database lo limita la cache in memoria di public-signups.server.ts (5 minuti,
// single-flight); la CDN e il browser aggiungono la loro con Cache-Control. Nessun limite per IP:
// il limitatore dell'app scrive sul database a ogni richiesta, costerebbe più del conteggio in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import {
  getPublicSignups,
  PublicSignupsUnavailableError,
} from '@/lib/business/public-signups.server';
import { PublicSignupsSchema } from '@/lib/contracts/public-signups';

// Mai calcolata durante la build: il conteggio si legge solo a richiesta.
export const dynamic = 'force-dynamic';

/**
 * Browser 1 minuto, CDN 10 minuti, poi copia vecchia servita mentre si aggiorna (fino a 1 ora).
 * Non esportata: un file route.ts di Next accetta solo i metodi HTTP e le opzioni di segmento.
 */
const PUBLIC_SIGNUPS_CACHE_CONTROL =
  'public, max-age=60, s-maxage=600, stale-while-revalidate=3600';

export async function GET() {
  try {
    // Il parse `strict` del contratto blocca qualunque campo oltre ai tre previsti.
    const body = PublicSignupsSchema.parse(await getPublicSignups());
    return NextResponse.json(body, {
      headers: { 'Cache-Control': PUBLIC_SIGNUPS_CACHE_CONTROL },
    });
  } catch (error) {
    // Un guasto del database è già registrato una volta per conteggio in public-signups.server.ts:
    // qui niente log per richiesta (la pausa di 30 s risponde subito a ogni visita). Si registra
    // solo un errore inatteso, col solo tipo: niente query, parametri o righe.
    if (!(error instanceof PublicSignupsUnavailableError)) {
      // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
      console.error(
        '[public/iscritti] risposta non disponibile:',
        error instanceof Error ? error.name : typeof error,
      );
    }
    return NextResponse.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } },
    );
  }
}
