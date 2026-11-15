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
//      al contratto/licenza (al massimo 300 caratteri). "testo": facoltativo, true solo se hai
//      anche i diritti sul TESTO (autori/editori): il player lo mostra (vedi featured-rights).
//      Nessun altro campo.
// 3. Il brano compare cercando titolo, artista o "Artista Titolo" (in cima a parità di
//    rilevanza, con il distintivo «In evidenza»). Una voce sbagliata viene ignorata da sola; un
//    manifest assente, non valido o troppo grande = nessun brano in evidenza nella ricerca.
// TEMPI (cache): l'indice segue la VERSIONE del catalogo (featured-catalog.server: impronta dello
// store, diritti.json compreso, rielencato al massimo ogni ~30 secondi per istanza). Una REVOCA
// (voce tolta, manifest rimosso o reso non valido: diritti.json cambia, quindi cambia la versione)
// vale nella ricerca di solito entro ~30-90 secondi (elenco condiviso + risposte con brani in
// evidenza in cache condivisa al massimo 1 minuto), comunque mai oltre i ~6 minuti di prima, con
// diritti.json PRIVATO; da pubblico va aggiunto il tempo di propagazione del CDN di Vercel Blob (la
// lettura può restituire la copia precedente anche dopo il cambio di versione, e nemmeno «Aggiorna
// ora» lo evita: l'indice la rilegge dopo ~5 minuti, e per questo la Home non mette in cache lunga
// i link costruiti da un manifest pubblico, vedi `manifestPublic`). Un brano APPENA dichiarato
// compare di solito entro un minuto, ma una ricerca già fatta di recente può restare in cache fino
// a ~20 minuti. «Aggiorna ora» nella pagina admin «Diritti e testi» forza subito un nuovo elenco su
// tutte le istanze (entro ~10 secondi).
// Tutte le regole sono in featured-rights.server.ts.
//
// Funzionamento: un indice in memoria (brani dichiarati, costruiti ESATTAMENTE come in Home:
// stessa copertina e stesso streamUrl, quindi la riproduzione è identica) costruito dall'elenco
// CONDIVISO dello store (lo stesso della Home e della versione: nessun elenco in più) e ricostruito
// quando cambia la versione del catalogo (o il contatore «Aggiorna ora»), al più tardi ogni ~5
// minuti anche a versione invariata (rilegge solo diritti.json); ~1 minuto dopo un errore di
// lettura. Mai a ogni ricerca: le ricerche concorrenti condividono la stessa ricostruzione. Non fa
// mai throw.
//
// Lo stesso indice dice anche quali brani possono mostrare il TESTO nel player (voci con
// "testo": true, vedi featured-lyrics.server.ts): stessa lettura dello store e del manifest, quindi
// stessi tempi di revoca.
//
// E raggruppa i brani dichiarati per ARTISTA (pagina /artista/<slug>, regole in
// featured-artists.ts): ogni brano dell'indice porta `artistSlug` (il suo artista principale), una
// pagina elenca SOLO brani dichiarati e un artista senza brani dichiarati non ha pagina (né link).
// Stessa costruzione e stessa cache: nessun elenco dello store in più.
//
// E dà a ogni brano dichiarato il suo link diretto «Condividi» (/evidenza/<shareId>): `shareId` è
// l'HMAC opaco del pathname (featured-share.server), calcolato qui mentre si costruisce l'indice, e
// la mappa shareId → brano contiene SOLO i dichiarati. Un brano non dichiarato non ha id e un id
// sconosciuto non porta a nulla (404). Una revoca vale alla ricostruzione successiva (al cambio di
// versione, di solito entro ~30-90 secondi) per l'API del brano, la pagina e i nuovi disegni; le copie già sulla CDN durano di più: la
// copertina per id fino a ~1 giorno (+ ~1 ora nei browser), la scheda JPEG fino a ~1 giorno più la
// finestra stale (fino a una settimana). Nessuna delle due contiene l'audio.
//
// E raggruppa i brani dichiarati per SEZIONE (cartella dello store, la radice è "In evidenza") per
// il «Mostra tutti (N)» della Home (pagina /cartella/<id>, regole in featured-sections.server):
// ogni sezione con almeno un brano dichiarato ha un id opaco, il titolo della Home e i suoi brani
// DICHIARATI dal più recente (al massimo 500). Un brano non dichiarato non è mai elencato né
// contato in N; una cartella senza brani dichiarati non ha id (nessun link, 404). Stessa
// costruzione e stessa cache: nessun elenco dello store in più.
//
// E dice, per ogni brano DICHIARATO, se la sua voce consente la COPIA OFFLINE (`offline` del brano,
// regola in offline-eligibility: licenza + "offline", doppioni conservativi): lo leggono la Home,
// le pagine d'artista e di sezione e la verifica delle copie già salvate (getFeaturedOfflineStatus).
// Il download vero (resolveFeaturedOfflineDownload) risolve l'id SOLO da questo indice (mai un
// percorso o un URL del client) e poi RILEGGE diritti.json dallo store a ogni richiesta: una revoca
// vale subito per i nuovi download, anche prima che l'indice si ricostruisca.
import 'server-only';
import { FEATURED_ARTIST_TRACK_LIMIT, type FeaturedArtist } from '@/lib/contracts/featured-artists';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import { UNIFIED_FEATURED_LIMIT } from '@/lib/contracts/unified-search';
import { env } from '@/lib/env';
import {
  type FeaturedArtistGroup,
  groupFeaturedArtists,
  isArtistSlug,
  primaryArtistSlug,
} from '@/lib/music/featured-artists';
import {
  clearFeaturedCatalogCacheForTests,
  type FeaturedCatalogState,
  loadFeaturedCatalogState,
} from '@/lib/music/featured-catalog.server';
import { clearFeaturedCatalogGenerationForTests } from '@/lib/music/featured-catalog-generation.server';
import {
  declaredTrackEntries,
  lyricsDeclared,
  offlineDeclared,
  RIGHTS_MANIFEST_PATHNAME,
  type RightsEntry,
  readRightsManifest,
} from '@/lib/music/featured-rights.server';
import { isFeaturedSectionId } from '@/lib/music/featured-sections';
import {
  type FeaturedSectionGroup,
  groupFeaturedSections,
} from '@/lib/music/featured-sections.server';
import { isFeaturedShareId } from '@/lib/music/featured-share';
import { featuredShareId, featuredShareSecret } from '@/lib/music/featured-share.server';
import {
  type HomeStoreFile,
  homeFoldersFromListing,
  homeTrackCatalogFromListing,
  isPublicBlobUrl,
  lyricsSidecarMatcher,
} from '@/lib/music/home-tracks.server';
import {
  type FeaturedOfflineBasis,
  featuredOfflinePermission,
} from '@/lib/music/offline-eligibility';
import { featuredRelevance } from '@/lib/music/unified-search';

/**
 * Esito certo (indice valido, oppure manifest assente, non valido o troppo grande): vale finché non
 * cambia la versione del catalogo, al più tardi ~5 minuti (poi si rilegge solo diritti.json
 * dall'elenco condiviso, senza rielencare lo store).
 */
const HIT_TTL_MS = 5 * 60_000;
/** Dopo un problema transitorio (store o manifest non leggibili, lenti o in errore): ~1 minuto. */
const FAILURE_TTL_MS = 60_000;
/** Rilevanza minima di un brano in evidenza rispetto alla query ("contiene" = 40). */
export const FEATURED_MIN_SCORE = 40;

/** Un brano in evidenza con i diritti sul TESTO dichiarati ("testo": true nel manifest). */
export type FeaturedLyricsSource = {
  /** Pathname del file audio nello store. */
  pathname: string;
  /** "titolare" della voce del manifest (per la riga di credito). */
  holder: string;
  /** true = audio pubblico (letto dal CDN), false = privato (letto con il token). */
  audioPublic: boolean;
  /** I file di testo con lo stesso nome del brano: prima i .lrc, poi i .txt. */
  sidecars: HomeStoreFile[];
};

export type FeaturedIndex = {
  /** false = Blob non configurato o non leggibile: la fonte è "unavailable", non "vuota". */
  available: boolean;
  /**
   * Solo i brani con diritti dichiarati, dal più recente (con `artistSlug` del principale e
   * `offline`: se la voce consente la copia offline).
   */
  tracks: HomeTrack[];
  /** Solo i brani dichiarati con "testo": true, per pathname. */
  lyrics: ReadonlyMap<string, FeaturedLyricsSource>;
  /** Gli artisti (principali e ospiti) dei SOLI brani dichiarati, per slug: mai un gruppo vuoto. */
  artists: ReadonlyMap<string, FeaturedArtistGroup<HomeTrack>>;
  /** Link diretti: shareId → brano, SOLO dichiarati (vuota con la condivisione spenta). */
  shares: ReadonlyMap<string, HomeTrack>;
  /** «Mostra tutti»: id → sezione con i SOLI brani dichiarati della cartella (mai vuota). */
  sections: ReadonlyMap<string, FeaturedSectionGroup>;
};

/** Esito della pagina «Mostra tutti» /cartella/<id>. */
export type FeaturedSectionLookup =
  | {
      outcome: 'found';
      /** root: la radice dello store (in Home «Ascolta ora»). */
      section: { id: string; title: string; root: boolean };
      tracks: HomeTrack[];
    }
  /** not_found: id malformato, sconosciuto o di una cartella senza brani dichiarati; unavailable:
   *  Blob non configurato o non leggibile. */
  | { outcome: 'not_found' | 'unavailable' };

/** Per la Home: il «Mostra tutti (N)» di una sezione (solo con brani dichiarati). */
export type FeaturedHomeSectionLink = {
  /** Id della pagina /cartella/<id>. */
  id: string;
  /** Quanti brani dichiarati elenca la pagina (sempre > 0). */
  count: number;
};

/** Esito del link diretto /evidenza/<shareId>. */
export type FeaturedShareLookup =
  | { outcome: 'found'; track: HomeTrack }
  /** not_found: id malformato, sconosciuto o di un brano non (più) dichiarato; unavailable: Blob
   *  non configurato o non leggibile. */
  | { outcome: 'not_found' | 'unavailable' };

/**
 * Per la Home: gli artisti con brani dichiarati, il link diretto dei brani dichiarati e il «Mostra
 * tutti» delle cartelle con brani dichiarati.
 */
export type FeaturedHomeLinks = {
  /** Gli slug degli artisti con ALMENO un brano dichiarato. */
  artists: ReadonlySet<string>;
  /** pathname → shareId, solo per i brani dichiarati. */
  shareIds: ReadonlyMap<string, string>;
  /**
   * Chiave della cartella (homeFolderKey: senza maiuscole, '' per la radice) → «Mostra tutti», solo
   * per le cartelle con almeno un brano dichiarato.
   */
  sections: ReadonlyMap<string, FeaturedHomeSectionLink>;
  /** pathname → copia offline consentita (true) o solo streaming (false), SOLO brani dichiarati. */
  offline: ReadonlyMap<string, boolean>;
  /** La versione del catalogo per cui è stato costruito l'indice (la Home la confronta con la sua). */
  version: string;
  /**
   * true = diritti.json è PUBBLICO: la sua lettura passa dal CDN di Vercel Blob e può essere la
   * copia precedente anche a versione già cambiata, quindi i link possono cambiare senza che cambi
   * la versione. La Home allora non li mette in cache lunga.
   */
  manifestPublic: boolean;
};

/** Esito della pagina d'artista. */
export type FeaturedArtistLookup =
  | { outcome: 'found'; artist: FeaturedArtist; tracks: HomeTrack[] }
  /** not_found: nessun brano dichiarato; unavailable: Blob non configurato o non leggibile. */
  | { outcome: 'not_found' | 'unavailable' };

export type FeaturedSearchResult = {
  outcome: 'results' | 'no_results' | 'unavailable';
  tracks: HomeTrack[];
};

/** Un indice con la versione (e il `seq`) del catalogo da cui è stato costruito. */
type IndexEntry = { index: FeaturedIndex; version: string; seq: number; manifestPublic: boolean };

let cached: (IndexEntry & { expiresAt: number }) | null = null;
let building: { seq: number; promise: Promise<IndexEntry> } | null = null;
/** Cambia a ogni svuotamento: una ricostruzione partita prima non scrive più nella cache. */
let cacheEpoch = 0;

/**
 * Butta l'indice di questa istanza: la prossima richiesta lo ricostruisce dall'elenco condiviso
 * («Aggiorna ora» della pagina admin).
 */
export function invalidateFeaturedSearchIndex() {
  cached = null;
  building = null;
  cacheEpoch += 1;
}

/** Svuota indice, elenco condiviso e contatore «Aggiorna ora» in memoria (solo per i test). */
export function clearFeaturedSearchCacheForTests() {
  invalidateFeaturedSearchIndex();
  clearFeaturedCatalogCacheForTests();
  clearFeaturedCatalogGenerationForTests();
}

const NO_LYRICS: ReadonlyMap<string, FeaturedLyricsSource> = new Map();
const NO_ARTISTS: ReadonlyMap<string, FeaturedArtistGroup<HomeTrack>> = new Map();
const NO_SHARES: ReadonlyMap<string, HomeTrack> = new Map();
const NO_SECTIONS: ReadonlyMap<string, FeaturedSectionGroup> = new Map();
const UNAVAILABLE: FeaturedIndex = {
  available: false,
  tracks: [],
  lyrics: NO_LYRICS,
  artists: NO_ARTISTS,
  shares: NO_SHARES,
  sections: NO_SECTIONS,
};

/**
 * I brani dichiarati con il loro link diretto (`shareId`) e la mappa shareId → brano. Senza
 * segreto del server la condivisione è spenta: nessun `shareId` (il campo resta assente) e mappa
 * vuota. Due pathname con lo stesso id (132 bit: in pratica mai) restano entrambi senza link,
 * così un link non può mai portare al brano sbagliato.
 */
function withShareIds(tracks: HomeTrack[]): {
  tracks: HomeTrack[];
  shares: ReadonlyMap<string, HomeTrack>;
} {
  const secret = featuredShareSecret();
  if (!secret) return { tracks, shares: NO_SHARES };
  const ids = tracks.map((track) => featuredShareId(track.id, secret));
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const shares = new Map<string, HomeTrack>();
  const linked = tracks.map((track, index) => {
    const shareId = ids[index];
    if (!shareId || seen.get(shareId) !== 1) return track;
    const withId = { ...track, shareId };
    shares.set(shareId, withId);
    return withId;
  });
  return { tracks: linked, shares };
}

type BuiltIndex = { index: FeaturedIndex; ttl: number; manifestPublic?: boolean };

async function buildIndex(token: string, state: FeaturedCatalogState): Promise<BuiltIndex> {
  // L'elenco CONDIVISO dello store (brani, copertine e manifest): nessuna list() in più qui.
  if (!state.configured) return { index: UNAVAILABLE, ttl: FAILURE_TTL_MS };
  const catalog = homeTrackCatalogFromListing(state.listing, [RIGHTS_MANIFEST_PATHNAME]);

  const manifestFile = catalog.files.get(RIGHTS_MANIFEST_PATHNAME) ?? null;
  // Elenco interrotto prima di trovare il manifest: non si sa se c'è → non leggibile, non "assente".
  if (!manifestFile && !catalog.complete) return { index: UNAVAILABLE, ttl: FAILURE_TTL_MS };
  // Manifest pubblico: letto dal CDN di Vercel Blob, può essere la copia precedente.
  const manifestPublic = manifestFile !== null && isPublicBlobUrl(manifestFile.url);

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
      index: {
        available: !transient,
        tracks: [],
        lyrics: NO_LYRICS,
        artists: NO_ARTISTS,
        shares: NO_SHARES,
        sections: NO_SECTIONS,
      },
      ttl: transient ? FAILURE_TTL_MS : HIT_TTL_MS,
      manifestPublic,
    };
  }

  const declared = declaredTrackEntries(
    rights.entries,
    catalog.tracks.map((track) => track.id),
  );
  const ignored = rights.skipped + (rights.entries.length - declared.size);
  if (ignored > 0) {
    console.warn(
      `[solco] ${RIGHTS_MANIFEST_PATHNAME}: ${ignored} voci ignorate (formato, licenza o file non valido o inesistente)`,
    );
  }
  // Ogni brano dichiarato ha la pagina del suo artista principale (il brano stesso la riempie) e,
  // con la condivisione accesa, il suo link diretto. SOLO i dichiarati: mai l'elenco completo.
  // Ogni brano dichiarato dice anche se la sua voce consente la copia offline (doppioni già
  // risolti dal parser in modo conservativo).
  const { tracks, shares } = withShareIds(
    catalog.tracks.flatMap((track) => {
      const entry = declared.get(track.id);
      return entry
        ? [
            {
              ...track,
              artistSlug: primaryArtistSlug(track.artist),
              offline: offlineDeclared(entry),
            },
          ]
        : [];
    }),
  );
  // Artisti: SOLO dai brani dichiarati (mai dall'elenco completo dello store).
  const artists = groupFeaturedArtists(tracks);
  // Sezioni «Mostra tutti»: SOLO i brani dichiarati, per cartella, con i titoli della Home (dallo
  // stesso elenco condiviso: ordine e doppioni come in Home).
  const sections = groupFeaturedSections(tracks, homeFoldersFromListing(state.listing));
  // Testi: solo le voci valide con "testo": true di file che esistono davvero nello store.
  const sidecarsFor = lyricsSidecarMatcher(catalog.sidecars);
  const lyrics = new Map<string, FeaturedLyricsSource>();
  for (const track of tracks) {
    const entry = declared.get(track.id);
    if (!entry || !lyricsDeclared(entry)) continue;
    lyrics.set(track.id, {
      pathname: track.id,
      holder: entry.titolare,
      audioPublic: /^https:\/\//.test(track.streamUrl),
      sidecars: sidecarsFor(track.id),
    });
  }
  // Elenco parziale (oltre il tetto di pagine o scaduto) ma manifest trovato: si usa quanto trovato
  // (al più MENO brani ricercabili, mai di più) per la finestra normale. Uno store sempre oltre il
  // tetto non rifà così 20 elenchi ogni minuto.
  return {
    index: { available: true, tracks, lyrics, artists, shares, sections },
    ttl: HIT_TTL_MS,
    manifestPublic,
  };
}

/**
 * L'indice per lo stato del catalogo `state`: dalla cache se costruito per lo stesso contenuto (e
 * non scaduto) o per uno più recente, altrimenti ricostruito UNA volta anche con più richieste in
 * parallelo. Un cambio di versione (nuovo `seq`) lo ricostruisce subito, senza aspettare HIT_TTL_MS.
 */
async function indexFor(token: string, state: FeaturedCatalogState): Promise<IndexEntry> {
  const now = Date.now();
  // Un indice di un contenuto PIÙ recente vale anche per chi ha in mano uno stato appena superato:
  // niente ricostruzioni avanti e indietro fra due versioni.
  if (cached && (cached.seq > state.seq || (cached.seq === state.seq && cached.expiresAt > now))) {
    return cached;
  }
  if (building && building.seq >= state.seq) return building.promise;
  const started = cacheEpoch;
  const store = ({ index, ttl, manifestPublic = false }: BuiltIndex): IndexEntry => {
    const entry = { index, version: state.version, seq: state.seq, manifestPublic };
    if (started === cacheEpoch && (!cached || state.seq >= cached.seq)) {
      cached = { ...entry, expiresAt: Date.now() + ttl };
    }
    return entry;
  };
  const promise: Promise<IndexEntry> = buildIndex(token, state)
    .then(store)
    .catch(() => store({ index: UNAVAILABLE, ttl: FAILURE_TTL_MS }))
    .finally(() => {
      if (building?.promise === promise) building = null;
    });
  building = { seq: state.seq, promise };
  return promise;
}

/** L'indice per lo stato attuale del catalogo (elenco condiviso, ~30 secondi). */
async function loadIndex(token: string): Promise<FeaturedIndex> {
  const state = await loadFeaturedCatalogState();
  return (await indexFor(token, state)).index;
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

/**
 * Pagina d'artista: i brani DICHIARATI in cui l'artista `slug` è principale o ospite (dal più
 * recente, al massimo `limit`) con la grafia più frequente del nome. Un brano non dichiarato dello
 * stesso artista non compare mai (l'indice contiene solo brani dichiarati). Stesso indice della
 * ricerca. Mai throw: Blob non configurato o non leggibile → 'unavailable'; nessun brano
 * dichiarato (o slug non valido) → 'not_found'.
 */
export async function getFeaturedArtist(
  slug: string,
  limit = FEATURED_ARTIST_TRACK_LIMIT,
): Promise<FeaturedArtistLookup> {
  if (!isArtistSlug(slug)) return { outcome: 'not_found' };
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { outcome: 'unavailable' };
  try {
    const index = await loadIndex(token);
    const group = index.artists.get(slug);
    if (group && group.tracks.length > 0) {
      return {
        outcome: 'found',
        artist: { name: group.name, slug: group.slug },
        tracks: group.tracks.slice(0, limit),
      };
    }
    return { outcome: index.available ? 'not_found' : 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}

/**
 * Gli slug degli artisti con ALMENO un brano dichiarato (stesso indice in cache della ricerca),
 * per mettere il link all'artista in Home solo dove la pagina non è vuota. null se l'indice non è
 * disponibile (Blob non configurato o non leggibile): nessun link. Mai throw.
 */
export async function loadFeaturedArtistSlugs(): Promise<ReadonlySet<string> | null> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const index = await loadIndex(token);
    return index.available ? new Set(index.artists.keys()) : null;
  } catch {
    return null;
  }
}

/**
 * Per la Home (che elenca anche brani NON dichiarati): gli artisti con almeno un brano dichiarato,
 * il link diretto dei SOLI brani dichiarati e il «Mostra tutti (N)» delle sole cartelle con brani
 * dichiarati (N = brani dichiarati), dallo stesso indice in cache, con la versione del
 * catalogo per cui è stato costruito. Con `state` usa quello stato del catalogo (lo stesso elenco
 * della risposta della Home), altrimenti quello attuale. null se l'indice non è disponibile (Blob
 * non configurato o non leggibile): nessun link. Mai throw.
 */
export async function loadFeaturedHomeLinks(
  state?: FeaturedCatalogState,
): Promise<FeaturedHomeLinks | null> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const entry = await indexFor(token, state ?? (await loadFeaturedCatalogState()));
    const { index } = entry;
    if (!index.available) return null;
    const shareIds = new Map<string, string>();
    for (const [shareId, track] of index.shares) shareIds.set(track.id, shareId);
    const sections = new Map<string, FeaturedHomeSectionLink>();
    for (const section of index.sections.values()) {
      if (section.tracks.length > 0) {
        sections.set(section.key, { id: section.id, count: section.tracks.length });
      }
    }
    const offline = new Map<string, boolean>();
    for (const track of index.tracks) offline.set(track.id, track.offline === true);
    return {
      artists: new Set(index.artists.keys()),
      shareIds,
      sections,
      offline,
      version: entry.version,
      manifestPublic: entry.manifestPublic,
    };
  } catch {
    return null;
  }
}

/**
 * La pagina «Mostra tutti» /cartella/<id>: titolo della sezione (come in Home) e i SOLI brani
 * dichiarati della cartella, dal più recente (al massimo 500). Un id malformato non tocca
 * l'indice; un id sconosciuto o di una cartella senza brani dichiarati → 'not_found'. Stesso
 * indice della ricerca. Mai throw: Blob non configurato o non leggibile → 'unavailable'.
 */
export async function getFeaturedSection(sectionId: string): Promise<FeaturedSectionLookup> {
  if (!isFeaturedSectionId(sectionId)) return { outcome: 'not_found' };
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { outcome: 'unavailable' };
  try {
    const index = await loadIndex(token);
    const section = index.sections.get(sectionId);
    if (section && section.tracks.length > 0) {
      return {
        outcome: 'found',
        section: { id: section.id, title: section.title, root: section.key === '' },
        tracks: section.tracks,
      };
    }
    return { outcome: index.available ? 'not_found' : 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}

/**
 * Il brano DICHIARATO del link diretto /evidenza/<shareId>. Un id malformato non tocca l'indice;
 * un id sconosciuto, di un brano non dichiarato (o non più) o con la condivisione spenta →
 * 'not_found' (stessa risposta per tutti). Stesso indice della ricerca. Mai throw: Blob non
 * configurato o non leggibile → 'unavailable'.
 */
export async function getFeaturedShare(shareId: string): Promise<FeaturedShareLookup> {
  if (!isFeaturedShareId(shareId)) return { outcome: 'not_found' };
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { outcome: 'unavailable' };
  try {
    const index = await loadIndex(token);
    const track = index.shares.get(shareId);
    if (track) return { outcome: 'found', track };
    return { outcome: index.available ? 'not_found' : 'unavailable' };
  } catch {
    return { outcome: 'unavailable' };
  }
}

/**
 * Il brano in evidenza `pathname` se il manifest ne dichiara i diritti sul TESTO ("testo": true) e
 * il file esiste nello store; altrimenti null (voce assente, non valida, "testo" mancante o false,
 * manifest assente/non valido, store non leggibile). Stesso indice della ricerca. Mai throw.
 */
export async function getFeaturedLyricsSource(
  pathname: string,
): Promise<FeaturedLyricsSource | null> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const index = await loadIndex(token);
    return index.lyrics.get(pathname) ?? null;
  } catch {
    return null;
  }
}

/** Esito della risoluzione di un download offline di un brano in evidenza (per shareId). */
export type FeaturedOfflineLookup =
  | {
      outcome: 'allowed';
      /** Il brano dell'indice (stessi dati della Home). */
      track: HomeTrack;
      /** La voce di diritti.json ATTUALE (riletta dallo store) che consente la copia. */
      entry: RightsEntry;
      /** Dove leggere l'audio: pubblico (CDN) o privato (token), e la sua dimensione se nota. */
      audio: { pathname: string; public: boolean; size: number | null };
    }
  /** Dichiarato, ma la voce ATTUALE non consente la copia offline. */
  | { outcome: 'not_permitted'; track: HomeTrack; basis: FeaturedOfflineBasis }
  /**
   * not_found: id malformato, sconosciuto, di un brano non (più) dichiarato o con la condivisione
   * spenta (stessa risposta per tutti); unavailable: Blob non configurato o non leggibile, o
   * diritti.json non leggibile in questo momento.
   */
  | { outcome: 'not_found' | 'unavailable' };

/**
 * Il download offline del brano dichiarato `shareId`. L'id si risolve SOLO dall'indice dei brani
 * dichiarati (mai un percorso dello store o un URL scelto dal client); poi diritti.json si RILEGGE
 * dallo store (lettura fresca, stesse regole del parser e dello stesso elenco) e il permesso si
 * ricalcola sulla voce attuale: una revoca vale subito, senza aspettare la ricostruzione
 * dell'indice. Manifest assente, non valido o voce tolta → not_found; lettura fallita →
 * unavailable. Mai throw.
 */
export async function resolveFeaturedOfflineDownload(
  shareId: string,
): Promise<FeaturedOfflineLookup> {
  if (!isFeaturedShareId(shareId)) return { outcome: 'not_found' };
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { outcome: 'unavailable' };
  try {
    const state = await loadFeaturedCatalogState();
    const { index } = await indexFor(token, state);
    const track = index.shares.get(shareId);
    if (!track) return { outcome: index.available ? 'not_found' : 'unavailable' };

    // Ricontrollo sul manifest ATTUALE: stesso elenco dell'indice (brani e diritti.json), ma il
    // contenuto di diritti.json riletto adesso dallo store.
    const catalog = homeTrackCatalogFromListing(state.listing, [RIGHTS_MANIFEST_PATHNAME]);
    const manifestFile = catalog.files.get(RIGHTS_MANIFEST_PATHNAME) ?? null;
    if (!manifestFile && !catalog.complete) return { outcome: 'unavailable' };
    const rights = await readRightsManifest(token, manifestFile);
    if (rights.status === 'unavailable') return { outcome: 'unavailable' };
    // Assente, non valido o troppo grande: nessun brano è dichiarato (come un id sconosciuto).
    if (rights.status !== 'ok') return { outcome: 'not_found' };
    const entry = declaredTrackEntries(
      rights.entries,
      catalog.tracks.map((item) => item.id),
    ).get(track.id);
    if (!entry) return { outcome: 'not_found' };

    const permission = featuredOfflinePermission(entry);
    if (!permission.allowed) return { outcome: 'not_permitted', track, basis: permission.basis };
    return {
      outcome: 'allowed',
      track,
      entry,
      audio: {
        pathname: track.id,
        // Come l'indice (e il player): stream diretto dal CDN = file pubblico.
        public: /^https:\/\//.test(track.streamUrl),
        size: catalog.audioSizes?.get(track.id) ?? null,
      },
    };
  } catch {
    return { outcome: 'unavailable' };
  }
}

/** Esito della verifica delle copie offline già salvate. */
export type FeaturedOfflineStatus =
  | { outcome: 'ok'; permitted: string[]; revoked: string[] }
  /** Blob non configurato o non leggibile: non si sa, le copie restano. */
  | { outcome: 'unavailable' };

/**
 * Quali copie offline (per shareId) sono ancora consentite: un id dichiarato con `offline` true è
 * permesso; uno sconosciuto, non più dichiarato o con la copia offline spenta è revocato (con
 * l'elenco dello store incompleto, solo quelli con la copia spenta: l'assenza non è certa). Stesso
 * indice in cache della ricerca (segue la versione del catalogo: di solito ~30-90 secondi, al più
 * ~6 minuti). Indice non disponibile → 'unavailable' (le copie restano: offline-first). Mai throw.
 */
export async function getFeaturedOfflineStatus(
  ids: readonly string[],
): Promise<FeaturedOfflineStatus> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { outcome: 'unavailable' };
  try {
    const state = await loadFeaturedCatalogState();
    // Elenco dello store fallito o degradato (dati parziali): un brano mancante potrebbe esserci
    // ancora, quindi non si revoca nulla adesso (si riprova alla verifica successiva).
    if (state.degraded || state.listing.failed) return { outcome: 'unavailable' };
    const { index } = await indexFor(token, state);
    if (!index.available) return { outcome: 'unavailable' };
    // Elenco fermo al tetto di pagine (riuscito ma INCOMPLETO): un id assente dall'indice potrebbe
    // essere un brano dichiarato oltre il tetto, quindi non è né permesso né revocato (la copia
    // resta com'è). Si revocano solo gli id che l'indice conosce con la copia offline spenta.
    const complete = state.listing.complete;
    const permitted: string[] = [];
    const revoked: string[] = [];
    for (const id of new Set(ids)) {
      const track = isFeaturedShareId(id) ? index.shares.get(id) : undefined;
      if (track?.offline === true) permitted.push(id);
      else if (track || complete) revoked.push(id);
    }
    return { outcome: 'ok', permitted, revoked };
  } catch {
    return { outcome: 'unavailable' };
  }
}
