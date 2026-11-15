// @polsia:user-owned — avvia in OGNI pagina la verifica delle copie offline dei "brani in evidenza"
// (featured-offline-sync), così una copia revocata in diritti.json sparisce dal dispositivo anche
// se l'ascoltatore riprende il player dalla Home o da un'altra pagina, senza aprire la Libreria.
//
// Leggero: legge solo il registro delle copie (localStorage). Il codice della verifica (e quello
// della libreria sul dispositivo) si carica con import() SOLO se su questo dispositivo c'è almeno
// una copia, adesso o dopo un download in questa scheda (evento del registro). Montato una volta
// da global-mounts.tsx; non mostra nulla.
'use client';

import { useEffect } from 'react';
import {
  FEATURED_OFFLINE_COPIES_CHANGED_EVENT,
  readFeaturedCopies,
} from '@/components/custom/music/featured-offline-copies';

export function FeaturedOfflineSyncMount() {
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    let stop: (() => void) | null = null;
    const ensure = () => {
      if (cancelled || loading || stop || readFeaturedCopies().length === 0) return;
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
    ensure();
    window.addEventListener(FEATURED_OFFLINE_COPIES_CHANGED_EVENT, ensure);
    window.addEventListener('online', ensure);
    return () => {
      cancelled = true;
      window.removeEventListener(FEATURED_OFFLINE_COPIES_CHANGED_EVENT, ensure);
      window.removeEventListener('online', ensure);
      stop?.();
    };
  }, []);
  return null;
}
