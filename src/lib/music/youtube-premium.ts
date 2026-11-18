// @polsia:user-owned — preferenza «Ho YouTube Premium» (lato client, per dispositivo).
//
// Spenta di default. La accende solo chi possiede YouTube Premium: allora, sui brani di YouTube, il
// player mostra il tasto «Apri in YouTube», che apre il video esatto nell'app/sito di YouTube, dove
// l'abbonamento dell'utente vale davvero (niente pubblicità, ascolto in background). Solco NON può
// usare il Premium dentro il proprio player incorporato: lo consente solo YouTube, non è una scelta
// nostra. Nessuna API, nessun login, nessun dato: solo un interruttore locale come gli altri di
// Impostazioni, con un evento di finestra per aggiornare le schede (useSyncExternalStore).
'use client';

import { useSyncExternalStore } from 'react';

const KEY = 'solco:youtube-premium';
const EVENT = 'solco:youtube-premium-changed';

function read(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Stato corrente (false lato server o se lo storage non è disponibile). */
export function getYouTubePremium(): boolean {
  return read();
}

/** Imposta la preferenza e avvisa gli ascoltatori (altri componenti, altre schede). */
export function setYouTubePremium(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Storage non disponibile (private, bloccato): la preferenza resta solo in memoria di questa scheda.
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Ambiente senza Event: niente aggiornamento reattivo, ma nulla si rompe.
  }
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) callback();
  };
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}

/** Hook reattivo: true quando l'utente ha dichiarato di avere YouTube Premium. */
export function useYouTubePremium(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
