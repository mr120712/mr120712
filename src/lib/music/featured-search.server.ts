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
//
// Lo stesso indice dice anche quali brani possono mostrare il TESTO nel player (voci con
// "testo": true, vedi featured-lyrics.server.ts): stessa lettura dello store e del manifest, quindi
// stessi tempi di revoca (~5 minuti).
//
// E raggruppa i brani dichiarati per ARTISTA (pagina /artista/<slug>, regole in
// featured-artists.ts): ogni brano dell'indice porta `artistSlug` (il suo artista principale), una
// pagina elenca SOLO brani dichiarati e un artista senza brani dichiarati non ha pagina (né link).
// Stessa costruzione e stessa cache: nessun elenco dello store in più.
//
// E dà a ogni brano dichiarato il suo link diretto «Condividi» (/evidenza/<shareId>): `shareId` è
// l'HMAC opaco del pathname (featured-share.server), calcolato qui mentre si costruisce l'indice, e
// la mappa shareId → brano contiene SOLO i dichiarati. Un brano non dichiarato non ha id e un id
// sconosciuto non porta a nulla (404). Una revoca vale alla ricostruzione successiva (~5 minuti)
// per l'API del brano, la pagina e i nuovi disegni; le copie già sulla CDN durano di più: la
// copertina per id fino a ~1 giorno (+ ~1 ora nei browser), la scheda JPEG fino a ~1 giorno più la
// finestra stale (fino a una settimana). Nessuna delle due contiene l'audio.
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
  declaredTrackEntries,
  lyricsDeclared,
  RIGHTS_MANIFEST_PATHNAME,
  readRightsManifest,
} from '@/lib/music/featured-rights.server';
import { isFeaturedShareId } from '@/lib/music/featured-share';
import { featuredShareId, featuredShareSecret } from '@/lib/music/featured-share.server';
import {
  type HomeStoreFile,
  listHomeTrackCatalog,
  lyricsSidecarMatcher,
} from '@/lib/music/home-tracks.server';
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
  /** Solo i brani con diritti dichiarati, dal più recente (con `artistSlug` del principale). */
  tracks: HomeTrack[];
  /** Solo i brani dichiarati con "testo": true, per pathname. */
  lyrics: ReadonlyMap<string, FeaturedLyricsSource>;
  /** Gli artisti (principali e ospiti) dei SOLI brani dichiarati, per slug: mai un gruppo vuoto. */
  artists: ReadonlyMap<string, FeaturedArtistGroup<HomeTrack>>;
  /** Link diretti: shareId → brano, SOLO dichiarati (vuota con la condivisione spenta). */
  shares: ReadonlyMap<string, HomeTrack>;
};

/** Esito del link diretto /evidenza/<shareId>. */
export type FeaturedShareLookup =
  | { outcome: 'found'; track: HomeTrack }
  /** not_found: id malformato, sconosciuto o di un brano non (più) dichiarato; unavailable: Blob
   *  non configurato o non leggibile. */
  | { outcome: 'not_found' | 'unavailable' };

/** Per la Home: gli artisti con brani dichiarati e il link diretto dei brani dichiarati. */
export type FeaturedHomeLinks = {
  /** Gli slug degli artisti con ALMENO un brano dichiarato. */
  artists: ReadonlySet<string>;
  /** pathname → shareId, solo per i brani dichiarati. */
  shareIds: ReadonlyMap<string, string>;
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

const NO_LYRICS: ReadonlyMap<string, FeaturedLyricsSource> = new Map();
const NO_ARTISTS: ReadonlyMap<string, FeaturedArtistGroup<HomeTrack>> = new Map();
const NO_SHARES: ReadonlyMap<string, HomeTrack> = new Map();
const UNAVAILABLE: FeaturedIndex = {
  available: false,
  tracks: [],
  lyrics: NO_LYRICS,
  artists: NO_ARTISTS,
  shares: NO_SHARES,
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
      index: {
        available: !transient,
        tracks: [],
        lyrics: NO_LYRICS,
        artists: NO_ARTISTS,
        shares: NO_SHARES,
      },
      ttl: transient ? FAILURE_TTL_MS : HIT_TTL_MS,
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
  const { tracks, shares } = withShareIds(
    catalog.tracks
      .filter((track) => declared.has(track.id))
      .map((track) => ({ ...track, artistSlug: primaryArtistSlug(track.artist) })),
  );
  // Artisti: SOLO dai brani dichiarati (mai dall'elenco completo dello store).
  const artists = groupFeaturedArtists(tracks);
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
  return { index: { available: true, tracks, lyrics, artists, shares }, ttl: HIT_TTL_MS };
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
 * Per la Home (che elenca anche brani NON dichiarati): gli artisti con almeno un brano dichiarato e
 * il link diretto dei SOLI brani dichiarati, dallo stesso indice in cache. null se l'indice non è
 * disponibile (Blob non configurato o non leggibile): nessun link. Mai throw.
 */
export async function loadFeaturedHomeLinks(): Promise<FeaturedHomeLinks | null> {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  try {
    const index = await loadIndex(token);
    if (!index.available) return null;
    const shareIds = new Map<string, string>();
    for (const [shareId, track] of index.shares) shareIds.set(track.id, shareId);
    return { artists: new Set(index.artists.keys()), shareIds };
  } catch {
    return null;
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
