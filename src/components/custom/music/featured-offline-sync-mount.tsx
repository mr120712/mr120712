// @polsia:user-owned — avvia in OGNI pagina la verifica delle copie offline dei "brani in evidenza"
// (featured-offline-sync), così una copia revocata in diritti.json sparisce dal dispositivo anche
// se l'ascoltatore riprende il player dalla Home o da un'altra pagina, senza aprire la Libreria.
//
// Leggero, soprattutto per chi NON ha copie (quasi tutti): prima legge il registro delle copie
// (localStorage). Se è vuoto (o perso, o illeggibile) guarda nella libreria sul dispositivo, che è
// la fonte di verità: se lì c'è una copia (fonte 'featured-download') la verifica parte lo stesso
// e ricostruisce la voce mancante. Ma non a ogni pagina: se non trova copie lo ricorda per un
// giorno (emptyDiskLookIsFresh in featured-offline-copies; il promemoria si toglie prima che una
// copia venga salvata e quando la verifica ne vede una), e la lettura parte solo quando il browser
// è libero, mai durante l'idratazione.
// Usa solo reader.ts (già nel bundle del player), legge i soli metadati e non crea il database a
// chi non ha mai usato «La tua musica». Se la libreria adesso non si legge, riprova da sola dopo
// qualche minuto, al ritorno online e quando la scheda torna visibile. Il codice della verifica (e
// quello completo della libreria sul dispositivo) si carica con import() SOLO se su questo
// dispositivo c'è almeno una copia, adesso o dopo un download in questa scheda (evento del
// registro).
//
// È anche il punto in cui le copie tolte dalla verifica escono dal PLAYER: la verifica ne segnala
// gli id (da qualunque parte sia partita, qui o dalla Libreria) e il player le toglie dalla coda,
// smette di suonarle e libera il file che teneva in memoria, come dopo «Rimuovi» in Libreria.
// Montato una volta da global-mounts.tsx, dentro il provider del player; non mostra nulla.
'use client';

import { useEffect, useRef } from 'react';
import {
  emptyDiskLookIsFresh,
  FEATURED_OFFLINE_COPIES_CHANGED_EVENT,
  FEATURED_OFFLINE_SOURCE,
  readFeaturedCopyRegistry,
  rememberEmptyDiskLook,
  subscribeFeaturedCopiesRemoved,
} from '@/components/custom/music/featured-offline-copies';
import { useOptionalMusicPlayer } from '@/components/custom/music/music-player';

/** Dopo quanto si riprova a guardare nella libreria se la lettura non è riuscita (~3 minuti). */
export const FEATURED_DISK_LOOK_RETRY_MS = 180_000;
/** Il browser ha al più questo tempo per trovare un momento libero prima della lettura. */
export const FEATURED_DISK_LOOK_IDLE_TIMEOUT_MS = 5_000;
/** Senza requestIdleCallback (Safari): la lettura parte dopo questa attesa. */
export const FEATURED_DISK_LOOK_DELAY_MS = 2_000;

/** Chiama `run` quando il browser è libero; torna la funzione che annulla la chiamata. */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: FEATURED_DISK_LOOK_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, FEATURED_DISK_LOOK_DELAY_MS);
  return () => clearTimeout(timer);
}

export function FeaturedOfflineSyncMount() {
  const player = useOptionalMusicPlayer();
  const playerRef = useRef(player);
  playerRef.current = player;

  // Copie tolte dalla verifica (revocate): fuori dalla coda e dalla memoria del player; se una
  // stava suonando, il player si ferma. Senza questo resterebbero ascoltabili finché il player
  // non prova a ricaricarle.
  useEffect(
    () =>
      subscribeFeaturedCopiesRemoved((localIds) => {
        playerRef.current?.forgetLocalTracks(localIds);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    let stop: (() => void) | null = null;
    // La ricerca di copie nella libreria sul dispositivo: da fare, in attesa di un momento
    // libero, in corso, fatta (in questa pagina non si ripete).
    let disk: 'idle' | 'waiting' | 'looking' | 'done' = 'idle';
    let copyOnDisk = false;
    let cancelWait: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const start = () => {
      if (cancelled || loading || stop) return;
      loading = true;
      import('@/components/custom/music/featured-offline-sync')
        .then((sync) => {
          loading = false;
          if (cancelled || stop) return;
          stop = sync.startFeaturedOfflineSync();
        })
        .catch(() => {
          // Modulo non caricato (rete assente al primo avvio): si riprova al prossimo evento.
          loading = false;
        });
    };

    const lookOnDisk = () => {
      cancelWait = null;
      if (cancelled) return;
      disk = 'looking';
      import('@/lib/local-music/reader')
        .then((reader) => reader.hasDownloadedTrack(FEATURED_OFFLINE_SOURCE))
        .then((found) => {
          if (cancelled) return;
          disk = 'done';
          copyOnDisk = found;
          if (found) start();
          // Nessuna copia: per un giorno le prossime pagine non riaprono la libreria per saperlo.
          // Non se intanto in questa scheda ne è stata salvata una (la verifica è già partita
          // dall'evento del registro): la lettura è cominciata prima e non la vede.
          else if (!loading && !stop) rememberEmptyDiskLook();
        })
        .catch(() => {
          // Modulo non caricato o libreria illeggibile adesso: non si sa se ci sono copie. Si
          // riprova da soli fra qualche minuto (e al prossimo evento), non solo al ricaricamento.
          if (cancelled) return;
          disk = 'idle';
          retry = setTimeout(ensure, FEATURED_DISK_LOOK_RETRY_MS);
        });
    };

    const ensure = () => {
      if (cancelled || loading || stop) return;
      const registry = readFeaturedCopyRegistry();
      if (copyOnDisk || registry.copies.length > 0) {
        start();
        return;
      }
      // Registro vuoto: lo dice il disco. Un registro che non si legge non dice nulla, quindi non
      // vale nemmeno il promemoria «nessuna copia»: si guarda comunque.
      if (disk !== 'idle' || (registry.readable && emptyDiskLookIsFresh())) return;
      if (retry) clearTimeout(retry);
      retry = null;
      disk = 'waiting';
      cancelWait = whenIdle(lookOnDisk);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') ensure();
    };

    ensure();
    window.addEventListener(FEATURED_OFFLINE_COPIES_CHANGED_EVENT, ensure);
    window.addEventListener('online', ensure);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(FEATURED_OFFLINE_COPIES_CHANGED_EVENT, ensure);
      window.removeEventListener('online', ensure);
      document.removeEventListener('visibilitychange', onVisible);
      cancelWait?.();
      if (retry) clearTimeout(retry);
      stop?.();
    };
  }, []);
  return null;
}
