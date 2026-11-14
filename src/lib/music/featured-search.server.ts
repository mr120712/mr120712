// @polsia:user-owned — i "brani in evidenza" (file audio che l'amministratore carica nello store
// Vercel Blob, mostrati in Home) nella RICERCA GLOBALE (GET /api/music/search-all, fonte
// `featured`). Solo i brani di cui l'amministratore ha DICHIARATO i diritti nel manifest
// `diritti.json` sono ricercabili: lo store contiene anche brani commerciali senza licenza, che
// la ricerca non deve rendere scopribili. La Home non cambia (mostra lo store come sempre).
//
// COME RENDERE RICERCABILE UN BRANO IN EVIDENZA
// 1. Carica il file audio nello store Blob come sempre (es. "Rock italiano/Artista - Titolo.mp3").
// 2. Carica (o aggiorna) nella RADICE dello stesso store, dal pannello Vercel Blob, un file
//    chiamato esattamente `diritti.json`, testo UTF-8 di al massimo 256 KB, caricato come PRIVATO
//    (si legge sempre dall'origine; da pubblico passa dal CDN di Vercel Blob e una modifica può
//    arrivare più tardi), per esempio:
//
//      {
//        "versione": 1,
//        "brani": [
//          {
//            "file": "Rock italiano/Artista - Titolo.mp3",
//            "licenza": "propria",
//            "titolare": "Artista"
//          },
//          {
//            "file": "Novità/Band - Singolo.flac",
//            "licenza": "licenza",
//            "titolare": "Etichetta Srl",
//            "prova": "Contratto di distribuzione n. 42 del 03/2026"
//          }
//        ]
//      }
//
//    - "file": il pathname ESATTO del file nello store (cartelle, maiuscole, spazi ed estensione
//      come nel pannello; niente "/" iniziale, "..", indirizzi web o "public-uploads/").
//    - "licenza": "propria" (brano tuo), "licenza" (per contratto con etichetta/distributore),
//      "cc0", "cc-by", "cc-by-sa" o "cc-by-nd". Le Creative Commons NON commerciali (NC) non sono
//      accettate: Solco vende abbonamenti Pro.
//    - "titolare": chi detiene i diritti (1-120 caratteri); "prova": facoltativa, nota o link
//      al contratto/licenza (al massimo 300 caratteri). Nessun altro campo.
// 3. Il brano compare cercando titolo, artista o "Artista Titolo" (in cima a parità di
//    rilevanza, con il distintivo «In evidenza»). Una voce sbagliata viene ignorata da sola; un
//    manifest assente, non valido o troppo grande = nessun brano in evidenza nella ricerca.
// TEMPI (cache): una REVOCA (voce tolta, manifest rimosso o reso non valido) vale nella ricerca
// entro ~6 minuti al massimo (indice in memoria fino a 5 minuti + risposte con brani in evidenza in
// cache condivisa al massimo 1 minuto), con diritti.json PRIVATO; da pubblico va aggiunto il tempo
// di propagazione del CDN di Vercel Blob. Un brano APPENA dichiarato compare di solito entro ~5
// minuti, ma una ricerca già fatta di recente può restare in cache fino a ~20 minuti.
// Tutte le regole sono in featured-rights.server.ts.
//
// Funzionamento: un indice in memoria (brani dichiarati, costruiti ESATTAMENTE come in Home:
// stessa copertina e stesso streamUrl, quindi la riproduzione è identica) ricostruito al massimo
// ogni ~5 minuti (anche con manifest assente, non valido o troppo grande; ~1 minuto dopo un errore
// di lettura); lo store si elenca una volta per finestra di cache, mai a ogni ricerca, e le ricerche
// concorrenti condividono la stessa ricostruzione. Non fa mai throw.
import 'server-only';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import { UNIFIED_FEATURED_LIMIT } from '@/lib/contracts/unified-search';
import { env } from '@/lib/env';
import {
  declaredTrackIds,
  RIGHTS_MANIFEST_PATHNAME,
  readRightsManifest,
} from '@/lib/music/featured-rights.server';
import { listHomeTrackCatalog } from '@/lib/music/home-tracks.server';
import { featuredRelevance } from '@/lib/music/unified-search';

/**
 * Esito certo, riusato per ~5 minuti: indice valido, oppure manifest assente (elenco completo), non
 * valido o troppo grande (stati stabili decisi dall'amministratore: nessun brano ricercabile, senza
 * rielencare tutto lo store ogni minuto).
 */
const HIT_TTL_MS = 5 * 60_000;
/** Dopo un problema transitorio (store o manifest non leggibili, lenti o in errore): ~1 minuto. */
const FAILURE_TTL_MS = 60_000;
/** Rilevanza minima di un brano in evidenza rispetto alla query ("contiene" = 40). */
export const FEATURED_MIN_SCORE = 40;

export type FeaturedIndex = {
  /** false = Blob non configurato o non leggibile: la fonte è "unavailable", non "vuota". */
  available: boolean;
  /** Solo i brani con diritti dichiarati, dal più recente. */
  tracks: HomeTrack[];
};

export type FeaturedSearchResult = {
  outcome: 'results' | 'no_results' | 'unavailable';
  tracks: HomeTrack[];
};

let cached: { index: FeaturedIndex; expiresAt: number } | null = null;
let building: Promise<FeaturedIndex> | null = null;
/** Cambia a ogni svuotamento: una ricostruzione partita prima non scrive più nella cache. */
let generation = 0;

/** Svuota la cache dell'indice (solo per i test). */
export function clearFeaturedSearchCacheForTests() {
  cached = null;
  building = null;
  generation += 1;
}

const UNAVAILABLE: FeaturedIndex = { available: false, tracks: [] };

async function buildIndex(token: string): Promise<{ index: FeaturedIndex; ttl: number }> {
  // UN solo elenco dello store per brani, copertine e manifest.
  const catalog = await listHomeTrackCatalog([RIGHTS_MANIFEST_PATHNAME]);
  if (!catalog) return { index: UNAVAILABLE, ttl: FAILURE_TTL_MS };

  const manifestFile = catalog.files.get(RIGHTS_MANIFEST_PATHNAME) ?? null;
  // Elenco interrotto prima di trovare il manifest: non si sa se c'è → non leggibile, non "assente".
  if (!manifestFile && !catalog.complete) return { index: UNAVAILABLE, ttl: FAILURE_TTL_MS };

  const rights = await readRightsManifest(token, manifestFile);
  if (rights.status !== 'ok') {
    if (rights.status === 'invalid' || rights.status === 'oversize') {
      console.warn(
        `[solco] ${RIGHTS_MANIFEST_PATHNAME} ${rights.status === 'oversize' ? 'oltre 256 KB' : 'non valido'}: nessun brano in evidenza nella ricerca`,
      );
    }
    // Nel dubbio si esclude tutto: nessun brano ricercabile. Assente/non valido/troppo grande sono
    // stati stabili (si ricontrolla dopo ~5 minuti); solo la lettura fallita si riprova presto.
    const transient = rights.status === 'unavailable';
    return {
      index: { available: !transient, tracks: [] },
      ttl: transient ? FAILURE_TTL_MS : HIT_TTL_MS,
    };
  }

  const declared = declaredTrackIds(
    rights.entries,
    catalog.tracks.map((track) => track.id),
  );
  const ignored = rights.skipped + (rights.entries.length - declared.size);
  if (ignored > 0) {
    console.warn(
      `[solco] ${RIGHTS_MANIFEST_PATHNAME}: ${ignored} voci ignorate (formato, licenza o file non valido o inesistente)`,
    );
  }
  const tracks = catalog.tracks.filter((track) => declared.has(track.id));
  // Elenco parziale (oltre il tetto di pagine o scaduto) ma manifest trovato: si usa quanto trovato
  // (al più MENO brani ricercabili, mai di più) per la finestra normale. Uno store sempre oltre il
  // tetto non rifà così 20 elenchi ogni minuto.
  return { index: { available: true, tracks }, ttl: HIT_TTL_MS };
}

/** L'indice dalla cache, oppure ricostruito una sola volta anche con più ricerche in parallelo. */
async function loadIndex(token: string): Promise<FeaturedIndex> {
  if (cached && cached.expiresAt > Date.now()) return cached.index;
  if (!building) {
    const started = generation;
    const store = (index: FeaturedIndex, ttl: number) => {
      if (started === generation) cached = { index, expiresAt: Date.now() + ttl };
      return index;
    };
    const current: Promise<FeaturedIndex> = buildIndex(token)
      .then(({ index, ttl }) => store(index, ttl))
      .catch(() => store(UNAVAILABLE, FAILURE_TTL_MS))
      .finally(() => {
        if (building === current) building = null;
      });
    building = current;
  }
  return building;
}

/**
 * I brani dell'indice pertinenti alla query: rilevanza su titolo, artista, "Artista Titolo" e
 * "Artista - Titolo" (almeno "contiene"; la stessa di rankUnifiedResults), dal più rilevante, a
 * parità dal più recente; al massimo `limit`.
 */
export function matchFeaturedTracks(
  tracks: readonly HomeTrack[],
  query: string,
  limit = UNIFIED_FEATURED_LIMIT,
): HomeTrack[] {
  return tracks
    .map((track, order) => ({
      track,
      order,
      score: featuredRelevance(track, query),
    }))
    .filter((entry) => entry.score >= FEATURED_MIN_SCORE)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, limit)
    .map((entry) => entry.track);
}

/**
 * Fonte `featured` della ricerca globale: i brani in evidenza con diritti dichiarati che
 * corrispondono alla query. Non fa mai throw: Blob non configurato o non leggibile → 'unavailable';
 * nessun brano dichiarato o pertinente → 'no_results'.
 */
export async function searchFeaturedTracks(
  query: string,
  limit = UNIFIED_FEATURED_LIMIT,
): Promise<FeaturedSearchResult> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { outcome: 'unavailable', tracks: [] };
  try {
    const index = await loadIndex(token);
    const tracks = matchFeaturedTracks(index.tracks, query, limit);
    if (tracks.length > 0) return { outcome: 'results', tracks };
    return { outcome: index.available ? 'no_results' : 'unavailable', tracks: [] };
  } catch {
    return { outcome: 'unavailable', tracks: [] };
  }
}
