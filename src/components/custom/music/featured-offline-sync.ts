// @polsia:user-owned — verifica delle COPIE OFFLINE dei "brani in evidenza" salvate su questo
// dispositivo: quando Solco è aperto (qualunque pagina, featured-offline-sync-mount in
// global-mounts, più la Libreria) e il browser è online, chiede al server
// (POST /api/music/featured/offline-status) quali copie sono ancora consentite da diritti.json e
// toglie dal dispositivo quelle revocate (voce tolta o non valida, "offline": false, licenza
// "licenza" senza "offline": true, brano non più nello store), con un avviso neutro.
//
// - Offline-first: errore di rete, risposta non valida, 429 o 503 → le copie RESTANO e si riprova
//   più tardi (al ritorno online, al prossimo caricamento di una pagina o dopo qualche minuto).
// - Quando: all'avvio, al ritorno online, dopo ~3 minuti se non è riuscita e, per le schede
//   aperte a lungo, quando la scheda torna visibile (al più ogni 10 minuti). Una verifica alla volta
//   in tutta la pagina e non più di una al minuto: l'avviso parte una volta sola per verifica.
//   Si tolgono SOLO gli id che il server indica esplicitamente come revocati.
// - Privacy: al server vanno SOLO gli id opachi (shareId) delle copie dei brani in evidenza, a
//   lotti di al massimo 100; mai titoli, nomi di file o dati degli altri brani del dispositivo.
// - Le voci del registro di copie che non sono più nella libreria (tolte a mano, «Rimuovi tutto»,
//   spazio liberato dal browser) si dimenticano senza chiedere nulla.
// - Una copia con la fonte 'featured-download' ma senza voce nel registro (non verificabile) si
//   toglie: nel dubbio si esclude. Oggi la libreria la rilegge come file locale, quindi questo
//   vale da quando src/lib/local-music riconoscerà la fonte.
'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import {
  type CopyStorage,
  FEATURED_OFFLINE_SOURCE,
  forgetFeaturedCopies,
  readFeaturedCopies,
} from '@/components/custom/music/featured-offline-copies';
import { notifyLocalMusicChanged } from '@/components/custom/music/offline-download';
import {
  FEATURED_OFFLINE_STATUS_MAX_IDS,
  FeaturedOfflineStatusResponseSchema,
} from '@/lib/contracts/offline';
import { type LocalTrack, listTracks, removeTrack } from '@/lib/local-music';

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
  /** Non riuscita (rete, server, libreria illeggibile): copie tenute, si riprova. */
  | { status: 'retry'; removed: number };

export type FeaturedSyncDeps = {
  fetcher?: typeof fetch;
  listTracks?: () => Promise<LocalTrack[]>;
  removeTrack?: (id: string) => Promise<void>;
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

/**
 * Una verifica completa. Mai throw: ogni problema diventa 'retry' e le copie restano. Toglie solo
 * le copie degli id che il server dichiara revocati (e quelle non verificabili, vedi sopra).
 */
export async function syncFeaturedOfflineCopies(
  deps: FeaturedSyncDeps = {},
): Promise<FeaturedSyncResult> {
  const fetcher = deps.fetcher ?? fetch;
  const readTracks = deps.listTracks ?? listTracks;
  const remove = deps.removeTrack ?? removeTrack;
  const storage = deps.storage;

  const copies = readFeaturedCopies(storage);
  let tracks: LocalTrack[];
  try {
    tracks = await readTracks();
  } catch {
    return { status: copies.length > 0 ? 'retry' : 'skipped', removed: 0 };
  }
  const present = new Set(tracks.map((track) => track.id));

  // Voci di copie che non sono più nella libreria: si dimenticano.
  const gone = copies.filter((copy) => !present.has(copy.localId)).map((copy) => copy.localId);
  if (gone.length > 0) forgetFeaturedCopies(gone, storage);
  const live = copies.filter((copy) => present.has(copy.localId));

  let removed = 0;
  // Copie con la fonte dei brani in evidenza ma senza voce nel registro: non verificabili.
  const registered = new Set(live.map((copy) => copy.localId));
  for (const track of tracks) {
    if ((track.source as string | undefined) !== FEATURED_OFFLINE_SOURCE) continue;
    if (registered.has(track.id)) continue;
    try {
      await remove(track.id);
      removed += 1;
    } catch {
      // Si riprova alla prossima verifica.
    }
  }

  if (live.length === 0) {
    if (removed > 0) notifyLocalMusicChanged();
    return { status: removed > 0 ? 'ok' : 'skipped', removed };
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

  const forgotten: string[] = [];
  for (const copy of live) {
    if (!revoked.has(copy.featuredId)) continue;
    try {
      await remove(copy.localId);
      forgotten.push(copy.localId);
      removed += 1;
    } catch {
      // Rimozione non riuscita: la voce resta, si riprova alla prossima verifica.
    }
  }
  if (forgotten.length > 0) forgetFeaturedCopies(forgotten, storage);
  if (removed > 0) notifyLocalMusicChanged();
  return { status: complete ? 'ok' : 'retry', removed };
}

let running: Promise<FeaturedSyncResult> | null = null;
let lastSuccessAt = 0;

/** Solo per i test: dimentica l'ultima verifica e quella in corso. */
export function resetFeaturedSyncForTests(): void {
  running = null;
  lastSuccessAt = 0;
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
