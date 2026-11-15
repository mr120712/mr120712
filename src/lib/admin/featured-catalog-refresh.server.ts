// @polsia:user-owned — «Aggiorna ora» della pagina admin «Diritti e testi»: fa comparire SUBITO,
// su tutte le istanze, i brani aggiunti o tolti dal pannello Vercel Blob (nessun webhook avvisa
// Solco dei caricamenti dal pannello). Incrementa il contatore condiviso nel database (le altre
// istanze lo vedono entro ~10 secondi e rielencano lo store), svuota le cache di QUESTA istanza
// (indice della ricerca/artisti/link diretti, elenco della diagnosi, avviso della ricerca) e
// rielenca subito lo store, così la risposta porta già la versione nuova. Le Home aperte la vedono
// al controllo successivo (versione in cache CDN al massimo 30 secondi + controllo ogni 30 secondi):
// entro circa un minuto. Costo: un elenco dello store per istanza attiva, una volta.
import 'server-only';
import { invalidateFeaturedRightsReportListing } from '@/lib/admin/featured-rights-report.server';
import { invalidateFeaturedSearchHint } from '@/lib/admin/featured-search-hint.server';
import type { AdminFeaturedRefreshResponse } from '@/lib/contracts/admin-featured-rights';
import { loadFeaturedCatalogState } from '@/lib/music/featured-catalog.server';
import { bumpFeaturedCatalogGeneration } from '@/lib/music/featured-catalog-generation.server';
import { invalidateFeaturedSearchIndex } from '@/lib/music/featured-search.server';

/**
 * Incrementa il contatore, svuota le cache di questa istanza e rielenca lo store. Fa throw solo se
 * il database non accetta l'incremento (allora non è cambiato niente); un elenco fallito dà
 * `stale: true` con l'ultima versione buona.
 */
export async function refreshFeaturedCatalogNow(): Promise<AdminFeaturedRefreshResponse> {
  // Il contatore nuovo resta in cache su questa istanza: la prossima lettura del catalogo è più
  // recente dell'ultimo elenco tentato, quindi rielenca lo store (tenendo l'ultimo buono di riserva).
  const generation = await bumpFeaturedCatalogGeneration();
  invalidateFeaturedSearchIndex();
  invalidateFeaturedRightsReportListing();
  invalidateFeaturedSearchHint();
  const state = await loadFeaturedCatalogState();
  return {
    generation,
    version: state.version,
    updatedAt: state.updatedAt,
    stale: state.stale,
  };
}
