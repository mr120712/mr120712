// @polsia:user-owned — GET /api/music/home-tracks/version: la VERSIONE attuale del catalogo dei
// "brani in evidenza" ({ version, updatedAt, listedAt }), che la Home controlla ogni ~30 secondi
// (solo con la scheda visibile) per riscaricare l'elenco SOLO quando cambia. Nessun dato utente,
// nessun login. Viene dall'elenco dello store condiviso da questa istanza (featured-catalog.server,
// ~30 secondi) ed è in cache sulla CDN al massimo 30 secondi (+ 60 di stale-while-revalidate): con
// tanti ascoltatori le richieste si fermano quasi tutte alla CDN e lo store si elenca al massimo
// una volta per finestra per istanza. Nessun rate-limit: una richiesta che aggira la cache legge
// solo la memoria (al più avvia l'elenco della finestra, condiviso).
//
// Tempi: qui l'istanza NON risponde con l'elenco scaduto (niente stale-while-revalidate
// dell'istanza: scaduta la finestra aspetta l'elenco nuovo; l'attesa la nasconde lo
// stale-while-revalidate della CDN) e `s-maxage` è il tempo che resta all'elenco, così la CDN non
// tiene mai una versione più a lungo dell'elenco da cui nasce. Prima le due attese si sommavano e
// un brano caricato poteva comparire dopo ~2 minuti; ora entro ~60 secondi.
//
// Mai una versione inaffidabile nella CDN:
// - nessun elenco buono (primo elenco fallito su un'istanza appena avviata) → 503 senza cache: il
//   client passa alla riserva senza versione e la sezione non sparisce;
// - contatore «Aggiorna ora» non ancora letto (database lento all'avvio) → risposta `no-store`:
//   la versione può cambiare fra un secondo.
// Non fa mai throw verso il client: 503 senza cache se qualcosa va storto.
import 'server-only';
import { NextResponse } from 'next/server';
import { HomeTracksVersionSchema } from '@/lib/contracts/home-tracks';
import {
  CATALOG_TTL_MS,
  keepAliveAfterResponse,
  loadFeaturedCatalogState,
} from '@/lib/music/featured-catalog.server';
import { loadFeaturedHomeLinks } from '@/lib/music/featured-search.server';

export const dynamic = 'force-dynamic';

const VERSION_MAX_AGE_S = Math.round(CATALOG_TTL_MS / 1000);

/** In CDN al massimo per il tempo che resta all'elenco dell'istanza (1-30 secondi) + 60 s stale. */
function versionCacheControl(freshForMs: number): string {
  const seconds = Math.max(1, Math.min(VERSION_MAX_AGE_S, Math.floor(freshForMs / 1000)));
  return `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=60`;
}

function unavailable() {
  return NextResponse.json(
    { error: 'version_unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function GET() {
  try {
    const state = await loadFeaturedCatalogState({ allowStale: false });
    // Elenco parziale o vuoto per errore, senza un elenco buono da servire: non è una versione.
    if (state.degraded) return unavailable();
    // Prepara l'indice (artisti e link diretti) per questa versione dopo la risposta: quando la Home
    // chiede l'elenco nuovo i link sono già pronti. Nessuna list() in più (stesso elenco); se è già
    // in cache finisce subito.
    keepAliveAfterResponse(loadFeaturedHomeLinks(state));
    const body = HomeTracksVersionSchema.parse({
      version: state.version,
      updatedAt: state.updatedAt,
      ...(state.listedAt ? { listedAt: state.listedAt } : {}),
    });
    const cache = state.generationKnown ? versionCacheControl(state.freshForMs) : 'no-store';
    return NextResponse.json(body, { headers: { 'Cache-Control': cache } });
  } catch {
    return unavailable();
  }
}
