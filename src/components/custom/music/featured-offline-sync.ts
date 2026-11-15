// @polsia:user-owned — verifica delle COPIE OFFLINE dei "brani in evidenza" salvate su questo
// dispositivo: quando Solco è aperto (qualunque pagina, featured-offline-sync-mount in
// global-mounts, più la Libreria) e il browser è online, chiede al server
// (POST /api/music/featured/offline-status) quali copie sono ancora consentite da diritti.json e
// toglie dal dispositivo quelle revocate (voce tolta o non valida, "offline": false, licenza
// "licenza" senza "offline": true, brano non più nello store), con un avviso neutro.
//
// - LA FONTE DI VERITÀ È LA LIBRERIA SUL DISPOSITIVO (IndexedDB, src/lib/local-music): una copia è
//   il record con la fonte 'featured-download', e l'id da verificare è nella sua chiave del
//   download ('featured:<shareId>'). Il registro in localStorage (featured-offline-copies) è la
//   copia veloce per l'interfaccia: una copia sul disco SENZA voce nel registro (registro perso,
//   svuotato o illeggibile) non si toglie e non resta senza controllo: la voce si RICOSTRUISCE
//   dal disco (id dalla chiave, attribuzione dal record) e la copia si verifica come le altre.
// - SOLO IL DISCO DECIDE CHE COSA SI PUÒ TOGLIERE. Una voce del registro su un brano che la
//   libreria non riconosce come copia (un file dell'ascoltatore: registro rovinato o manomesso) si
//   dimentica e il file NON si tocca, qualunque cosa risponda il server. Il registro serve alla
//   verifica solo per dare l'id a una copia riconosciuta dal disco che ha la chiave illeggibile.
// - Offline-first: errore di rete, risposta non valida, 429 o 503 → le copie RESTANO e si riprova
//   più tardi (al ritorno online, al prossimo caricamento di una pagina o dopo qualche minuto).
//   Si riprova anche se la libreria non si riesce a leggere (non si sa se ci sono copie: il
//   registro vuoto non lo dice più) e se una copia revocata non si è riusciti a toglierla: una
//   verifica vale come riuscita solo se ogni copia è stata verificata e ogni revocata tolta.
// - Quando: all'avvio, al ritorno online, dopo ~3 minuti se non è riuscita e, per le schede
//   aperte a lungo, quando la scheda torna visibile (al più ogni 10 minuti). Una verifica alla volta
//   in tutta la pagina e non più di una al minuto: l'avviso parte una volta sola per verifica.
//   Si tolgono SOLO gli id che il server indica esplicitamente come revocati.
// - Una copia tolta esce anche dal player (coda, brano in corso, file già in memoria): la verifica
//   ne segnala gli id (announceFeaturedCopiesRemoved) e featured-offline-sync-mount li passa al
//   player, come fa «Rimuovi» in Libreria.
// - Privacy: al server vanno SOLO gli id opachi (shareId) delle copie dei brani in evidenza, a
//   lotti di al massimo 100; mai titoli, nomi di file o dati degli altri brani del dispositivo.
// - Le voci del registro di copie che non sono più nella libreria (tolte a mano, «Rimuovi tutto»,
//   spazio liberato dal browser) si dimenticano senza chiedere nulla.
// - UNICA rimozione senza risposta del server: una copia la cui chiave del download è malformata
//   (dal disco non si legge nessun id) e che non ha nemmeno una voce nel registro. Non si può
//   verificare in nessun modo, quindi nel dubbio si esclude. Ma solo se il registro si è potuto
//   leggere e scrivere: se localStorage non è disponibile (o il registro è illeggibile) non si sa
//   se una voce c'era, quindi la copia RESTA e si riprova più tardi.
// - Una volta per pagina, prima di leggere, rimette sul disco la fonte delle copie che la versione
//   precedente ha riscritto come 'local' (repairFeaturedCopySources): in lettura sono già copie,
//   così tornano a dirlo anche i loro record.
'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import {
  announceFeaturedCopiesRemoved,
  type CopyStorage,
  canRememberFeaturedCopies,
  FEATURED_OFFLINE_SOURCE,
  type FeaturedOfflineCopy,
  forgetEmptyDiskLook,
  forgetFeaturedCopies,
  readFeaturedCopyRegistry,
  rememberFeaturedCopies,
} from '@/components/custom/music/featured-offline-copies';
import { notifyLocalMusicChanged } from '@/components/custom/music/offline-download';
import {
  FEATURED_OFFLINE_STATUS_MAX_IDS,
  FeaturedOfflineStatusResponseSchema,
} from '@/lib/contracts/offline';
import {
  type LocalTrack,
  listTracks,
  removeTrack,
  repairFeaturedCopySources,
} from '@/lib/local-music';
// Dai moduli puri, non dall'indice: niente IndexedDB, solo la lettura della chiave e della fonte.
import { featuredCopyShareId } from '@/lib/local-music/download-key';
import { localTrackAttribution, localTrackSource } from '@/lib/local-music/types';

/** Rotta della verifica. */
export const FEATURED_OFFLINE_STATUS_ENDPOINT = '/api/music/featured/offline-status';
/** Fra due verifiche riuscite (aperture ripetute della Libreria, ritorni online): almeno 1 minuto. */
export const FEATURED_SYNC_MIN_INTERVAL_MS = 60_000;
/** Dopo una verifica non riuscita si riprova da soli dopo ~3 minuti (se la pagina è aperta). */
export const FEATURED_SYNC_RETRY_MS = 180_000;
/** Scheda che torna visibile: si ricontrolla se l'ultima verifica riuscita ha più di 10 minuti. */
export const FEATURED_SYNC_REVISIT_MS = 600_000;

export type FeaturedSyncResult =
  /** Niente da verificare (nessuna copia di brani in evidenza). */
  | { status: 'skipped'; removed: number }
  /** Verifica fatta: `removed` copie revocate tolte dal dispositivo. */
  | { status: 'ok'; removed: number }
  /**
   * Non riuscita (rete, server, libreria illeggibile, una copia revocata che non si è riusciti a
   * togliere): le copie non verificate restano e si riprova. `removed` conta quelle tolte comunque.
   */
  | { status: 'retry'; removed: number };

export type FeaturedSyncDeps = {
  fetcher?: typeof fetch;
  listTracks?: () => Promise<LocalTrack[]>;
  removeTrack?: (id: string) => Promise<void>;
  /**
   * Rimette sul disco la fonte delle copie che l'hanno persa (predefinito: quella della libreria
   * sul dispositivo). Un suo errore non ferma la verifica: in lettura quelle copie sono già copie.
   */
  repairSources?: () => Promise<unknown>;
  storage?: CopyStorage | null;
  /** L'avviso dopo aver tolto copie revocate (predefinito: un toast neutro). */
  notify?: (message: string) => void;
};

/** L'avviso neutro dopo aver tolto copie revocate. */
export function featuredRevokedNotice(count: number): string {
  return count === 1
    ? 'Un brano in evidenza non è più disponibile offline: l’abbiamo tolto da questo dispositivo. Puoi sempre ascoltarlo in streaming, se resta su Solco.'
    : `${count} brani in evidenza non sono più disponibili offline: li abbiamo tolti da questo dispositivo. Puoi sempre ascoltarli in streaming, se restano su Solco.`;
}

/** Chiede al server un lotto di id: la risposta valida, o null (errore: si tiene tutto). */
async function askStatus(
  fetcher: typeof fetch,
  ids: readonly string[],
): Promise<{ permitted: string[]; revoked: string[] } | null> {
  let response: Response;
  try {
    response = await fetcher(FEATURED_OFFLINE_STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ids }),
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const parsed = FeaturedOfflineStatusResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

/** Una copia da verificare: il brano della libreria e l'id opaco da chiedere al server. */
type LiveCopy = { localId: string; featuredId: string };

/**
 * True se in questo browser una libreria sul dispositivo non può esistere (IndexedDB assente):
 * l'unico caso in cui «la libreria non si legge» vuol dire davvero «nessuna copia».
 */
function libraryCannotExist(): boolean {
  return typeof indexedDB === 'undefined';
}

/** La riparazione delle fonti sul disco è già riuscita in questa pagina (si fa una volta sola). */
let sourcesRepaired = false;

/**
 * Una verifica completa. Mai throw: ogni problema diventa 'retry' e le copie restano. Toglie solo
 * le copie degli id che il server dichiara revocati (e, senza risposta del server, solo quelle che
 * non si possono verificare in nessun modo: vedi sopra). Toglie solo brani che la LIBRERIA
 * riconosce come copie di brani in evidenza: mai un file dell'ascoltatore.
 */
export async function syncFeaturedOfflineCopies(
  deps: FeaturedSyncDeps = {},
): Promise<FeaturedSyncResult> {
  const fetcher = deps.fetcher ?? fetch;
  const readTracks = deps.listTracks ?? listTracks;
  const remove = deps.removeTrack ?? removeTrack;
  const storage = deps.storage;

  if (!sourcesRepaired) {
    try {
      await (deps.repairSources ?? repairFeaturedCopySources)();
      sourcesRepaired = true;
    } catch {
      // Libreria non scrivibile adesso: le copie si riconoscono comunque in lettura, dalla loro
      // chiave. Si riprova alla prossima verifica.
    }
  }

  const registry = readFeaturedCopyRegistry(storage);
  let tracks: LocalTrack[];
  try {
    tracks = await readTracks();
  } catch {
    // La libreria non si legge: non si sa se ci sono copie (lo dice lei, non il registro), quindi
    // non è una verifica riuscita e si riprova. «Niente da verificare» solo dove una libreria non
    // può esistere e il registro, leggibile, è vuoto.
    const nothingToVerify =
      libraryCannotExist() && registry.readable && registry.copies.length === 0;
    return { status: nothingToVerify ? 'skipped' : 'retry', removed: 0 };
  }

  // Le copie, a partire dal DISCO: è la fonte del record a dire che un brano è una copia.
  const copies = tracks.filter((track) => localTrackSource(track) === FEATURED_OFFLINE_SOURCE);
  const copyIds = new Set(copies.map((track) => track.id));
  const present = new Set(tracks.map((track) => track.id));
  // Una copia c'è: il promemoria «sul disco non c'è nessuna copia» del mount non deve restare,
  // nemmeno se l'ha salvata una scheda con la versione precedente (che non lo toglie).
  if (copies.length > 0) forgetEmptyDiskLook(storage);

  // Voci del registro senza una copia sul disco: il brano non c'è più (tolto a mano, «Rimuovi
  // tutto», spazio liberato) oppure c'è ma la libreria NON lo riconosce come copia (un file
  // dell'ascoltatore). Si dimenticano senza chiedere nulla, e il brano non si tocca: una voce del
  // registro da sola non basta mai a togliere un file dal dispositivo.
  const stale = registry.copies
    .filter((copy) => !copyIds.has(copy.localId))
    .map((copy) => copy.localId);
  const forgotten = stale.length > 0 && forgetFeaturedCopies(stale, storage);
  // Un brano che resta nella libreria ha perso l'etichetta di copia: l'interfaccia lo rilegge.
  let changed = forgotten && stale.some((localId) => present.has(localId));
  const registered = new Map(
    registry.copies
      .filter((copy) => copyIds.has(copy.localId))
      .map((copy) => [copy.localId, copy] as const),
  );

  // Che cosa verificare: la chiave del download dà l'id; il registro serve solo dove la chiave
  // non si legge.
  const live: LiveCopy[] = [];
  const rebuilt: FeaturedOfflineCopy[] = [];
  const unverifiable: string[] = [];
  for (const track of copies) {
    const entry = registered.get(track.id) ?? null;
    const featuredId = featuredCopyShareId(track.downloadKey);
    if (featuredId) {
      live.push({ localId: track.id, featuredId });
      // Voce mancante (o con un altro id): si ricostruisce dal disco.
      if (entry?.featuredId !== featuredId) {
        rebuilt.push({
          localId: track.id,
          featuredId,
          attribution: localTrackAttribution(track) ?? entry?.attribution ?? null,
          savedAt: entry?.savedAt ?? track.addedAt,
        });
      }
      continue;
    }
    // Chiave malformata: dal disco non si legge l'id. Resta quello del registro, se c'è.
    if (entry) live.push({ localId: track.id, featuredId: entry.featuredId });
    else unverifiable.push(track.id);
  }

  // Il registro è solo la copia veloce: se non si riesce a riscriverlo la verifica prosegue con
  // gli id letti dal disco. Se cambia, chi lo legge (pulsanti «Scarica offline», «La tua musica»)
  // viene avvisato, come dopo una rimozione.
  if (rebuilt.length > 0 && rememberFeaturedCopies(rebuilt, storage)) changed = true;

  /** Gli id della libreria delle copie tolte dal dispositivo in questa verifica. */
  const removedIds: string[] = [];
  // Qualcosa è rimasto in sospeso (né verificato né tolto): si riprova più tardi.
  let pending = false;
  /** Toglie una copia dal dispositivo; se non ci riesce resta in sospeso (si riprova). */
  const removeCopy = async (localId: string): Promise<boolean> => {
    try {
      await remove(localId);
    } catch {
      pending = true;
      return false;
    }
    removedIds.push(localId);
    return true;
  };
  // Quante delle copie tolte sono già state segnalate.
  let announced = 0;
  /**
   * Avvisa chi tiene in mano ciò che è cambiato finora: il player per le copie appena tolte (le
   * toglie dalla coda e smette di suonarle), «La tua musica» e i pulsanti «Scarica offline» per
   * rileggere libreria e registro.
   */
  const announce = () => {
    const fresh = removedIds.slice(announced);
    announced = removedIds.length;
    announceFeaturedCopiesRemoved(fresh);
    if (changed || fresh.length > 0) notifyLocalMusicChanged();
    changed = false;
  };

  if (unverifiable.length > 0) {
    if (registry.readable && canRememberFeaturedCopies(storage)) {
      // Nessun id sul disco e nessuna voce in un registro che funziona: non verificabili.
      for (const localId of unverifiable) await removeCopy(localId);
    } else {
      // Registro non disponibile: non si sa se una voce c'era. Le copie restano.
      pending = true;
    }
  }

  // Voci ricostruite o dimenticate, copie non verificabili tolte: l'interfaccia lo sa subito,
  // senza aspettare la risposta del server.
  announce();
  if (live.length === 0) {
    const removed = removedIds.length;
    return { status: pending ? 'retry' : removed > 0 ? 'ok' : 'skipped', removed };
  }

  const ids = [...new Set(live.map((copy) => copy.featuredId))];
  const revoked = new Set<string>();
  let complete = true;
  for (let start = 0; start < ids.length; start += FEATURED_OFFLINE_STATUS_MAX_IDS) {
    const answer = await askStatus(
      fetcher,
      ids.slice(start, start + FEATURED_OFFLINE_STATUS_MAX_IDS),
    );
    if (!answer) {
      // Rete o server non disponibili: quanto già saputo vale, il resto si riprova.
      complete = false;
      break;
    }
    for (const id of answer.revoked) revoked.add(id);
  }

  const dropped: string[] = [];
  for (const copy of live) {
    if (!revoked.has(copy.featuredId)) continue;
    // Rimozione non riuscita: la copia e la sua voce restano, e la verifica NON vale come
    // riuscita (si riprova fra qualche minuto, non solo al prossimo caricamento).
    if (await removeCopy(copy.localId)) dropped.push(copy.localId);
  }
  if (dropped.length > 0) forgetFeaturedCopies(dropped, storage);
  announce();
  return { status: complete && !pending ? 'ok' : 'retry', removed: removedIds.length };
}

let running: Promise<FeaturedSyncResult> | null = null;
let lastSuccessAt = 0;

/** Solo per i test: dimentica l'ultima verifica, quella in corso e la riparazione già fatta. */
export function resetFeaturedSyncForTests(): void {
  running = null;
  lastSuccessAt = 0;
  sourcesRepaired = false;
}

/**
 * Una verifica alla volta in tutta la pagina, non più di una ogni `minIntervalMs` se l'ultima è
 * riuscita. Chi la avvia ne dà l'avviso (una volta sola); chi arriva mentre è in corso riceve lo
 * stesso esito senza un secondo avviso.
 */
export function runFeaturedOfflineSync(
  deps: FeaturedSyncDeps = {},
  now = Date.now(),
  minIntervalMs = FEATURED_SYNC_MIN_INTERVAL_MS,
): Promise<FeaturedSyncResult> | null {
  if (running) return running;
  if (lastSuccessAt > 0 && now - lastSuccessAt < minIntervalMs) return null;
  const notify = deps.notify ?? ((message: string) => toast(message));
  const current = syncFeaturedOfflineCopies(deps)
    .then((result) => {
      if (result.status !== 'retry') lastSuccessAt = Date.now();
      if (result.removed > 0) notify(featuredRevokedNotice(result.removed));
      return result;
    })
    .finally(() => {
      if (running === current) running = null;
    });
  running = current;
  return current;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Avvia la verifica delle copie offline dei brani in evidenza per questa pagina: subito se online,
 * al ritorno online, quando la scheda torna visibile (al più ogni FEATURED_SYNC_REVISIT_MS) e di
 * nuovo dopo FEATURED_SYNC_RETRY_MS se una verifica non è riuscita. Torna la funzione che la ferma.
 */
export function startFeaturedOfflineSync(deps: FeaturedSyncDeps = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let active = true;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => {
    if (retry) clearTimeout(retry);
    retry = null;
  };
  const attempt = (minIntervalMs = FEATURED_SYNC_MIN_INTERVAL_MS) => {
    if (!active || !isOnline()) return;
    const pending = runFeaturedOfflineSync(deps, Date.now(), minIntervalMs);
    if (!pending) return;
    void pending.then((result) => {
      if (!active) return;
      clearRetry();
      if (result.status === 'retry') retry = setTimeout(() => attempt(), FEATURED_SYNC_RETRY_MS);
    });
  };
  const onOnline = () => attempt();
  const onVisible = () => {
    if (document.visibilityState === 'visible') attempt(FEATURED_SYNC_REVISIT_MS);
  };
  attempt();
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    active = false;
    clearRetry();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** La verifica finché il componente è montato (la Libreria; nelle altre pagine la monta il mount). */
export function useFeaturedOfflineSync(): void {
  useEffect(() => startFeaturedOfflineSync(), []);
}
