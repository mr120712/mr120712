// @polsia:user-owned — VERSIONE del catalogo dei "brani in evidenza" (store Vercel Blob) e l'UNICO
// elenco dello store condiviso da Home, ricerca, pagine d'artista, link diretti e testi.
//
// Perché: l'amministratore aggiunge e toglie brani dal pannello Vercel Blob e nessun webhook avvisa
// Solco. Prima ogni ascoltatore con la Home aperta interrogava lo store (list(), a consumo) ogni
// minuto aggirando la CDN, e la ricerca vedeva le novità solo ogni ~5 minuti. Ora:
// - questa istanza elenca lo store UNA volta per finestra (~30 secondi) e tutti usano quell'elenco
//   (single-flight: richieste concorrenti condividono lo stesso elenco);
// - dall'elenco nasce un'impronta (pathname, dimensione, data di caricamento e URL di brani,
//   immagini, file di testo e diritti.json; mai public-uploads/) e quindi una VERSIONE di 16 cifre
//   esadecimali, che include anche il contatore «Aggiorna ora» (featured-catalog-generation) e la
//   build in esecuzione;
// - la Home chiede solo la versione (GET /api/music/home-tracks/version, in cache CDN 30 s) e
//   riscarica l'elenco (GET /api/music/home-tracks?v=<versione>, in cache CDN un giorno: il
//   contenuto di una versione non cambia mai) solo quando cambia;
// - l'indice della ricerca (featured-search.server) si ricostruisce quando cambia la versione
//   invece di aspettare ~5 minuti: diritti.json fa parte dell'impronta, quindi anche una revoca
//   vale entro la stessa finestra.
//
// COSTO ATTESO (list() di Vercel Blob, a consumo): circa UN elenco ogni ~30 secondi per istanza,
// SOLO mentre arrivano richieste, qualunque sia il numero di ascoltatori (un elenco = una list()
// per ogni 1000 oggetti dello store). Uno store oltre il tetto di 20 pagine si rielenca ogni ~5
// minuti. Nessun timer sul server: un'istanza senza richieste non interroga niente. Le risposte
// della CDN (versione 30 s, elenco per versione un giorno) assorbono quasi tutte le richieste dei
// client, quindi le istanze attive restano poche.
//
// Stale-while-revalidate: scaduta la finestra, per un altro minuto si risponde con l'ultimo elenco
// buono mentre il nuovo si prepara (tenuto in vita dopo la risposta con after()); oltre, o se
// l'amministratore ha premuto «Aggiorna ora», si aspetta l'elenco nuovo. La route della VERSIONE
// non usa questa scorciatoia (`allowStale: false`): scaduta la finestra aspetta l'elenco nuovo e
// dice alla CDN di tenerla solo per il tempo che resta all'elenco (`freshForMs`), perché le due
// attese "stale" (istanza + CDN) sommate portavano una novità a ~2 minuti. Così una versione in
// CDN viene sempre da un elenco di al massimo ~30 secondi prima: un brano caricato compare entro
// ~60 secondi (finestra dell'elenco + un controllo della Home ogni 30 secondi).
// Un elenco fallito (errore o scadenza) non sostituisce mai l'ultimo buono: si continua con quello,
// segnalato come `stale`. Non fa mai throw.
import 'server-only';
import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { env } from '@/lib/env';
import { readFeaturedCatalogGeneration } from '@/lib/music/featured-catalog-generation.server';
import { RIGHTS_MANIFEST_PATHNAME } from '@/lib/music/featured-rights.server';
import {
  EMPTY_HOME_TRACK_NAMES,
  type HomeTrackNames,
  TITLES_MANIFEST_PATHNAME,
} from '@/lib/music/home-track-names';
import { readHomeTrackNames } from '@/lib/music/home-track-names.server';
import {
  collectHomeStore,
  EMPTY_HOME_STORE_LISTING,
  type HomeStoreListing,
} from '@/lib/music/home-tracks.server';

/** Un elenco resta valido ~30 secondi: novità e rimozioni compaiono ovunque entro ~30-60 secondi. */
export const CATALOG_TTL_MS = 30_000;
/** Dopo la finestra, per quanto ancora si serve l'ultimo elenco buono mentre si rielenca. */
export const CATALOG_STALE_GRACE_MS = 60_000;
/** Uno store oltre il tetto di pagine (20 list() a elenco) si rielenca solo ogni ~5 minuti. */
export const CAPPED_CATALOG_TTL_MS = 5 * 60_000;
/** Cambia se cambia la forma delle risposte per versione (le vecchie copie in CDN non valgono più). */
const CATALOG_FORMAT = 'solco-featured-1';
/** Gli oggetti chiesti per nome nello stesso elenco: i manifest dei diritti e dei titoli. */
const WANTED_FILES: ReadonlySet<string> = new Set([
  RIGHTS_MANIFEST_PATHNAME,
  TITLES_MANIFEST_PATHNAME,
]);

/** Formato della versione: 16 cifre esadecimali minuscole. */
export const CATALOG_VERSION_PATTERN = /^[0-9a-f]{16}$/;

export type FeaturedCatalogState = {
  /** false = Blob non configurato: catalogo vuoto (ma con una versione valida). */
  configured: boolean;
  /** La versione del contenuto: impronta dello store + contatore «Aggiorna ora» + build. */
  version: string;
  /** Quando questa istanza ha visto per la prima volta questa versione (ISO). */
  updatedAt: string;
  /**
   * Quando è riuscito l'ultimo elenco che conferma questo contenuto (ISO; null = nessun elenco
   * buono). Va solo avanti: la Home lo usa per non tornare a una versione più vecchia servita da
   * un'istanza rimasta indietro.
   */
  listedAt: string | null;
  /** true = l'ultimo elenco è fallito: si serve l'ultimo buono (o un elenco parziale). */
  stale: boolean;
  /** true = nessun elenco buono (solo uno parziale o vuoto per errore): mai pubblicato come versione. */
  degraded: boolean;
  /**
   * false = il contatore «Aggiorna ora» non è ancora stato letto (istanza appena avviata, database
   * lento): la versione può cambiare fra un attimo, quindi non va in cache lunga.
   */
  generationKnown: boolean;
  /** Per quanto l'elenco resta ancora nella finestra (ms): la CDN non tiene la versione più a lungo. */
  freshForMs: number;
  /** Il contatore «Aggiorna ora» con cui è stato fatto l'elenco. */
  generation: number;
  /** Cresce a ogni contenuto nuovo di questa istanza: l'indice lo usa per non tornare indietro. */
  seq: number;
  /** L'elenco condiviso (mai public-uploads/). */
  listing: HomeStoreListing;
  /**
   * Titoli e artisti personalizzati (titoli.json, letto insieme all'elenco; vuoto se il file non
   * c'è o non è valido). null = non leggibile in questo momento (errore di rete o scadenza): la
   * Home non pubblica il contenuto come definitivo e si riprova con l'elenco successivo.
   */
  names: HomeTrackNames | null;
};

type Content = {
  seq: number;
  listing: HomeStoreListing;
  names: HomeTrackNames | null;
  fingerprint: string;
  generation: number;
  /** Quando questo contenuto è comparso (ms). */
  since: number;
  /** false = elenco parziale per errore o scadenza, tenuto solo perché non c'era di meglio. */
  good: boolean;
};

type Snapshot = {
  content: Content;
  /** Ultimo tentativo di elenco, riuscito o no (ms). */
  checkedAt: number;
  /** Ultimo elenco RIUSCITO (ms; 0 = nessuno). */
  listedAt: number;
  /** Il contatore più alto per cui si è già tentato un elenco. */
  attemptedGeneration: number;
  stale: boolean;
};

let snapshot: Snapshot | null = null;
let refreshing: { promise: Promise<Snapshot>; generation: number } | null = null;
let seqCounter = 0;
let lastCompletedSeq = 0;
/** Cambia a ogni svuotamento: un elenco partito prima non scrive più nella cache. */
let epoch = 0;
const UNCONFIGURED_SINCE = new Date().toISOString();

/** Svuota l'elenco condiviso (solo per i test; il contatore ha la sua funzione). */
export function clearFeaturedCatalogCacheForTests() {
  snapshot = null;
  refreshing = null;
  lastCompletedSeq = seqCounter;
  epoch += 1;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Impronta dell'elenco (16 cifre esadecimali): cambia se un brano, un'immagine, un file di testo o
 * diritti.json viene aggiunto, tolto o sostituito (dimensione, data di caricamento o URL diversi).
 * Indipendente dall'ordine in cui lo store restituisce gli oggetti.
 */
export function homeStoreFingerprint(listing: HomeStoreListing): string {
  const lines: string[] = [];
  const add = (kind: string, blobs: HomeStoreListing['audio']) => {
    for (const blob of blobs) {
      const uploadedAt = blob.uploadedAt instanceof Date ? blob.uploadedAt.getTime() : NaN;
      lines.push(`${kind}\t${blob.pathname}\t${blob.size}\t${uploadedAt}\t${blob.url}`);
    }
  };
  add('a', listing.audio);
  add('i', listing.images);
  add('s', listing.sidecars);
  add('n', listing.named);
  lines.sort();
  lines.push(listing.complete ? 'complete' : 'partial');
  return sha256Hex(lines.join('\n')).slice(0, 16);
}

/** La build in esecuzione: un nuovo deploy cambia la versione (le copie in CDN si rinnovano). */
function buildId(): string {
  return process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? '';
}

/** La versione pubblica: impronta + contatore «Aggiorna ora» + build + formato delle risposte. */
export function featuredCatalogVersion(fingerprint: string, generation: number): string {
  return sha256Hex(`${CATALOG_FORMAT}\n${buildId()}\n${generation}\n${fingerprint}`).slice(0, 16);
}

function ttlOf(current: Snapshot): number {
  return current.content.good && !current.content.listing.complete
    ? CAPPED_CATALOG_TTL_MS
    : CATALOG_TTL_MS;
}

/**
 * Tiene viva la promessa dopo la risposta (after(), cioè waitUntil su Vercel), così un elenco o un
 * indice avviato in background finisce anche se la funzione verrebbe congelata. Fuori da una
 * richiesta (avvio, test) after() non è disponibile: la promessa prosegue da sola. Mai throw.
 */
export function keepAliveAfterResponse(task: Promise<unknown>) {
  try {
    after(
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
  } catch {
    // Fuori da una richiesta: niente da fare.
  }
}

/**
 * I titoli personalizzati per un elenco riuscito: titoli.json letto dallo store (vuoto se manca,
 * non è valido o è troppo grande: stati stabili), null se la lettura non è riuscita ora.
 */
async function namesFor(
  token: string,
  file: HomeStoreListing['named'][number],
): Promise<HomeTrackNames | null> {
  try {
    const read = await readHomeTrackNames(token, {
      pathname: file.pathname,
      url: file.url,
      size: file.size,
      uploadedAt: file.uploadedAt,
    });
    if (read.status === 'ok') return read.names;
    if (read.status === 'unavailable') return null;
    if (read.status !== 'missing') {
      // biome-ignore lint/suspicious/noConsole: avviso del server (solo lo stato del file, mai dati).
      console.warn(
        `[solco] ${TITLES_MANIFEST_PATHNAME} ${read.status === 'oversize' ? 'oltre 256 KB' : 'non valido'}: titoli e artisti dal nome del file`,
      );
    }
    return EMPTY_HOME_TRACK_NAMES;
  } catch {
    return null;
  }
}

/** Applica l'esito di un elenco alla cache e restituisce lo stato da usare. */
function settle(
  seq: number,
  generation: number,
  listing: HomeStoreListing,
  names: HomeTrackNames | null,
): Snapshot {
  const now = Date.now();
  const current = snapshot;
  // Un elenco partito prima di uno già concluso arriva tardi: non tocca la cache.
  if (seq < lastCompletedSeq && current) return current;
  lastCompletedSeq = seq;
  const attemptedGeneration = Math.max(current?.attemptedGeneration ?? 0, generation);

  if (!listing.failed) {
    const fingerprint = homeStoreFingerprint(listing);
    const same =
      current?.content.good === true &&
      current.content.fingerprint === fingerprint &&
      current.content.generation === generation &&
      // titoli.json letto ora dopo una lettura fallita: contenuto nuovo (l'indice lo rifà).
      (current.content.names !== null || names === null);
    // Stessa versione: si tiene il contenuto (e il suo `seq`), così l'indice non si ricostruisce.
    const content: Content = same
      ? current.content
      : { seq, listing, names, fingerprint, generation, since: now, good: true };
    snapshot = { content, checkedAt: now, listedAt: now, attemptedGeneration, stale: false };
    return snapshot;
  }
  if (current?.content.good) {
    // Elenco fallito: si continua con l'ultimo buono (stessa versione e stesso `listedAt`),
    // segnalato come `stale`.
    snapshot = { ...current, checkedAt: now, attemptedGeneration, stale: true };
    return snapshot;
  }
  // Niente di meglio: l'elenco parziale (anche vuoto), mai preso per buono.
  snapshot = {
    content: {
      seq,
      listing,
      names,
      fingerprint: homeStoreFingerprint(listing),
      generation,
      since: now,
      good: false,
    },
    checkedAt: now,
    listedAt: current?.listedAt ?? 0,
    attemptedGeneration,
    stale: true,
  };
  return snapshot;
}

/** Un nuovo elenco dello store, UNO solo anche con più richieste insieme. */
function refresh(token: string, generation: number): Promise<Snapshot> {
  if (refreshing && refreshing.generation >= generation) return refreshing.promise;
  const started = epoch;
  const seq = ++seqCounter;
  const promise: Promise<Snapshot> = collectHomeStore(token, WANTED_FILES)
    .catch((): HomeStoreListing => ({ ...EMPTY_HOME_STORE_LISTING, complete: false, failed: true }))
    .then((listing) => {
      // titoli.json si legge solo con un elenco riuscito (con uno fallito non si sa se c'è) e solo
      // se c'è: senza, l'esito si applica subito, con gli stessi passaggi di prima.
      if (listing.failed) return finish(listing, null);
      const file = listing.named.find((blob) => blob.pathname === TITLES_MANIFEST_PATHNAME);
      if (!file) return finish(listing, EMPTY_HOME_TRACK_NAMES);
      return namesFor(token, file).then(
        (names) => finish(listing, names),
        () => finish(listing, null),
      );
    })
    .finally(() => {
      if (refreshing?.promise === promise) refreshing = null;
    });
  refreshing = { promise, generation };
  return promise;

  /** L'esito dell'elenco (con i titoli personalizzati letti, o null) applicato alla cache. */
  function finish(listing: HomeStoreListing, names: HomeTrackNames | null): Snapshot {
    if (started !== epoch) {
      // Cache svuotata nel frattempo: l'esito vale solo per chi lo aspettava.
      const fingerprint = homeStoreFingerprint(listing);
      return {
        content: {
          seq,
          listing,
          names,
          fingerprint,
          generation,
          since: Date.now(),
          good: !listing.failed,
        },
        checkedAt: Date.now(),
        listedAt: listing.failed ? 0 : Date.now(),
        attemptedGeneration: generation,
        stale: listing.failed,
      };
    }
    return settle(seq, generation, listing, names);
  }
}

async function loadSnapshot(
  token: string,
  generation: number,
  allowStale: boolean,
): Promise<Snapshot> {
  const current = snapshot;
  if (current) {
    // «Aggiorna ora» (contatore più alto di quello già tentato): si aspetta l'elenco nuovo.
    const forced = generation > current.attemptedGeneration;
    const age = Date.now() - current.checkedAt;
    const ttl = ttlOf(current);
    if (!forced && age < ttl) return current;
    if (allowStale && !forced && current.content.good && age < ttl + CATALOG_STALE_GRACE_MS) {
      keepAliveAfterResponse(refresh(token, generation));
      return current;
    }
  }
  return refresh(token, generation);
}

function stateOf(current: Snapshot, generationKnown: boolean): FeaturedCatalogState {
  const { content } = current;
  return {
    configured: true,
    version: featuredCatalogVersion(content.fingerprint, content.generation),
    updatedAt: new Date(content.since).toISOString(),
    listedAt: current.listedAt > 0 ? new Date(current.listedAt).toISOString() : null,
    stale: current.stale,
    degraded: !content.good,
    generationKnown,
    freshForMs: Math.max(0, ttlOf(current) - (Date.now() - current.checkedAt)),
    generation: content.generation,
    seq: content.seq,
    listing: content.listing,
    names: content.names,
  };
}

/**
 * Lo stato del catalogo (versione + elenco condiviso) di questa istanza: dalla cache (~30
 * secondi), servendo l'ultimo elenco buono mentre se ne prepara uno nuovo (salvo
 * `allowStale: false`: scaduta la finestra si aspetta l'elenco nuovo), oppure elencando lo store
 * UNA volta anche con più richieste insieme. Mai throw.
 */
export async function loadFeaturedCatalogState(
  options: { allowStale?: boolean } = {},
): Promise<FeaturedCatalogState> {
  const { generation, known } = await readFeaturedCatalogGeneration().catch(() => ({
    generation: 0,
    known: false,
  }));
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return {
      configured: false,
      version: featuredCatalogVersion(homeStoreFingerprint(EMPTY_HOME_STORE_LISTING), generation),
      updatedAt: UNCONFIGURED_SINCE,
      listedAt: null,
      stale: false,
      degraded: false,
      generationKnown: known,
      freshForMs: CATALOG_TTL_MS,
      generation,
      seq: 0,
      listing: EMPTY_HOME_STORE_LISTING,
      names: EMPTY_HOME_TRACK_NAMES,
    };
  }
  return stateOf(await loadSnapshot(token, generation, options.allowStale !== false), known);
}
