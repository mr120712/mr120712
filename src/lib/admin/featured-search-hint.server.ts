// @polsia:user-owned — l'avviso «Solo per admin» della ricerca: quanti "brani in evidenza" dello
// store Vercel Blob corrispondono alla query e quanti di questi la ricerca NON mostra perché non sono
// dichiarati in diritti.json (o perché diritti.json manca o non vale). Lo usa SOLO la route privata
// GET /api/admin/featured-rights/search-hint (admin con email verificata); la ricerca pubblica
// (search-all) non cambia e non passa di qui.
//
// COERENZA CON LA RICERCA VERA: la parte «mostrati» NON è ricalcolata qui. Viene dall'INDICE della
// ricerca (searchFeaturedTracks di featured-search.server, la stessa cache di search-all) con la
// stessa rilevanza e la stessa soglia, senza il tetto dei risultati mostrati:
// - matchedDeclared = i brani che la ricerca trova davvero per la query, in questo momento;
// - matchedUndeclared = i brani dello store pertinenti alla query (stessa funzione:
//   matchFeaturedTracks) che la ricerca NON trova. Un brano che la ricerca mostra non è mai contato
//   come nascosto, anche subito dopo una modifica a diritti.json;
// - manifest = lo stato di diritti.json letto qui (stessa lettura della ricerca: readRightsManifest,
//   elenco interrotto prima di trovarlo → "non leggibile"), ma 'valid' quando la ricerca mostra
//   brani in evidenza per la query: allora l'indice usa ancora un diritti.json valido e l'avviso non
//   dice «nessun brano compare» sopra dei brani che compaiono.
// L'elenco completo dello store (anche i brani non dichiarati) non è nell'indice della ricerca, che
// tiene solo i dichiarati: per questo qui c'è un elenco a parte, con le stesse finestre di cache
// dell'indice (~5 minuti con un esito certo, ~1 minuto dopo un errore di lettura).
// TEMPI: l'elenco qui e l'indice della ricerca si rinnovano in momenti diversi. Per al massimo una
// finestra (~5 minuti) dopo una modifica allo store o a diritti.json, i NUMERI restano coerenti con
// ciò che la ricerca mostra (vengono dalla ricerca stessa), ma un brano appena dichiarato che la
// ricerca non ha ancora indicizzato è contato fra i nascosti, e un diritti.json appena tolto o
// rotto risulta 'missing'/'invalid' solo per le query in cui la ricerca non mostra già nulla. Una
// risposta di search-all in cache CDN (al massimo 1 minuto) può essere un po' più vecchia
// dell'indice.
//
// Cache: elenco dello store + diritti.json letti UNA volta per finestra (anche con richieste
// concorrenti, che condividono la stessa lettura) e mai a ogni ricerca; l'indice della ricerca ha la
// sua (condivisa con search-all). L'elenco della pagina «Diritti e testi»
// (featured-rights-report.server) ha una cache sua, non esportata.
//
// Fuori di qui escono SOLO lo stato del manifest e due numeri: mai titoli, artisti o percorsi.
// Non fa mai throw.
import 'server-only';
import type { AdminSearchHint, AdminSearchHintManifest } from '@/lib/contracts/admin-search-hint';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import { env } from '@/lib/env';
import { RIGHTS_MANIFEST_PATHNAME, readRightsManifest } from '@/lib/music/featured-rights.server';
import { matchFeaturedTracks, searchFeaturedTracks } from '@/lib/music/featured-search.server';
import { listHomeTrackCatalog } from '@/lib/music/home-tracks.server';

/** Come l'indice della ricerca: un esito certo (manifest valido, assente o non valido) ~5 minuti. */
export const SEARCH_HINT_TTL_MS = 5 * 60_000;
/** Come l'indice della ricerca: dopo un errore di lettura (store o manifest) ~1 minuto. */
export const SEARCH_HINT_FAILURE_TTL_MS = 60_000;

/** Lo store come lo legge l'avviso: stato del manifest e TUTTI i brani in evidenza. */
type HintSnapshot = {
  manifest: AdminSearchHintManifest;
  /** Tutti i brani dello store costruiti come in Home (senza public-uploads/). */
  tracks: readonly HomeTrack[];
};

const UNAVAILABLE: HintSnapshot = { manifest: 'unavailable', tracks: [] };
const UNAVAILABLE_HINT: AdminSearchHint = {
  manifest: 'unavailable',
  matchedDeclared: 0,
  matchedUndeclared: 0,
};

let cached: { snapshot: HintSnapshot; expiresAt: number } | null = null;
let building: Promise<HintSnapshot> | null = null;
/** Cambia a ogni svuotamento: una lettura partita prima non scrive più nella cache. */
let generation = 0;

/** Svuota la cache dell'avviso (solo per i test). */
export function clearFeaturedSearchHintCacheForTests() {
  cached = null;
  building = null;
  generation += 1;
}

/** Elenco + diritti.json, con le stesse decisioni di buildIndex in featured-search.server. */
async function buildSnapshot(token: string): Promise<HintSnapshot> {
  // UN solo elenco dello store per brani e manifest.
  const catalog = await listHomeTrackCatalog([RIGHTS_MANIFEST_PATHNAME]);
  if (!catalog) return UNAVAILABLE;

  const manifestFile = catalog.files.get(RIGHTS_MANIFEST_PATHNAME) ?? null;
  // Come la ricerca: elenco interrotto prima di trovare il manifest → non si sa se c'è.
  if (!manifestFile && !catalog.complete) return UNAVAILABLE;

  const rights = await readRightsManifest(token, manifestFile);
  if (rights.status === 'unavailable') return UNAVAILABLE;
  return {
    // Assente, non valido o oltre 256 KB: la ricerca non mostra nessun brano in evidenza.
    manifest:
      rights.status === 'ok' ? 'valid' : rights.status === 'missing' ? 'missing' : 'invalid',
    tracks: catalog.tracks,
  };
}

/** Lo stato dalla cache, oppure letto UNA volta anche con più richieste in parallelo. */
async function loadSnapshot(token: string): Promise<HintSnapshot> {
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
  if (!building) {
    const started = generation;
    const store = (snapshot: HintSnapshot) => {
      if (started === generation) {
        const ttl =
          snapshot.manifest === 'unavailable' ? SEARCH_HINT_FAILURE_TTL_MS : SEARCH_HINT_TTL_MS;
        cached = { snapshot, expiresAt: Date.now() + ttl };
      }
      return snapshot;
    };
    const current: Promise<HintSnapshot> = buildSnapshot(token)
      .then(store)
      .catch(() => store(UNAVAILABLE))
      .finally(() => {
        if (building === current) building = null;
      });
    building = current;
  }
  return building;
}

/**
 * L'avviso per la query (già validata): stato di diritti.json, brani pertinenti che la ricerca
 * mostra (dall'indice della ricerca stessa) e brani pertinenti dello store che non mostra. Solo
 * numeri, costruiti campo per campo. Mai throw: Blob non configurato o non leggibile (dall'avviso o
 * dalla ricerca) → 'unavailable' con zero brani.
 */
export async function getFeaturedSearchHint(query: string): Promise<AdminSearchHint> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return UNAVAILABLE_HINT;
  try {
    const [snapshot, shown] = await Promise.all([
      loadSnapshot(token),
      // Ciò che la ricerca mostra, senza tetto: la stessa funzione, soglia e cache di search-all.
      searchFeaturedTracks(query, Number.POSITIVE_INFINITY),
    ]);
    if (snapshot.manifest === 'unavailable' || shown.outcome === 'unavailable') {
      return UNAVAILABLE_HINT;
    }
    const shownIds = new Set(shown.tracks.map((track) => track.id));
    const hidden = snapshot.tracks.filter((track) => !shownIds.has(track.id));
    return {
      manifest: shown.tracks.length > 0 ? 'valid' : snapshot.manifest,
      matchedDeclared: shown.tracks.length,
      matchedUndeclared:
        hidden.length === 0
          ? 0
          : matchFeaturedTracks(hidden, query, Number.POSITIVE_INFINITY).length,
    };
  } catch {
    return UNAVAILABLE_HINT;
  }
}
