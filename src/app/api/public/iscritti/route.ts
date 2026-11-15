// @polsia:user-owned — contatore PUBBLICO degli iscritti per la landing (GET, senza login): totale
// degli account non bloccati e nuovi negli ultimi 7 giorni. Solo numeri aggregati, nessun dato
// personale; il dettaglio (bloccati, admin, verificati, grafico per giorno) resta in /admin.
// Il carico sul database lo limita la cache in memoria di public-signups.server.ts (20 secondi,
// single-flight); la CDN aggiunge la sua con Cache-Control, il browser no (max-age=0). Un nuovo
// account compare sulla landing entro circa un minuto (conto sotto). Nessun limite per IP:
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
 * Browser 0 secondi (a ogni caricamento della landing chiede alla CDN), CDN 20 secondi, poi per
 * altri 20 la copia vecchia servita mentre la CDN la aggiorna in background (chi arriva in quella
 * finestra non aspetta il database). Caso peggiore di un caricamento nuovo: valore dell'istanza
 * vecchio di 20 s (24 se chiesto durante un conteggio) + 20 s di s-maxage + 20 s di
 * stale-while-revalidate = 60 s (64). Fanno eccezione solo i secondi subito dopo un conteggio
 * fallito, quando l'istanza ripiega sull'ultimo valore (vedi public-signups.server.ts).
 * Non esportata: un file route.ts di Next accetta solo i metodi HTTP e le opzioni di segmento.
 */
const PUBLIC_SIGNUPS_CACHE_CONTROL = 'public, max-age=0, s-maxage=20, stale-while-revalidate=20';

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
