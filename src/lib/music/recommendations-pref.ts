// @polsia:user-owned — preferenza «Consigli personalizzati» (lato client, per dispositivo).
//
// Accesa di default. Spenta, la riga della Home chiede al server solo «Popolari su Solco»
// (?personal=0): il server non legge i tuoi ascolti, Preferiti, playlist e diario per i consigli.
// Salvata in localStorage come gli altri interruttori di Impostazioni; ogni scheda/componente si
// aggiorna tramite un evento di finestra.
'use client';

import { useSyncExternalStore } from 'react';

const KEY = 'solco:recommendations';
const EVENT = 'solco:recommendations-changed';

function read(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** Stato corrente (true lato server o se lo storage non è disponibile). */
export function getPersonalRecommendations(): boolean {
  return read();
}

/** Imposta la preferenza e avvisa gli ascoltatori (altri componenti, altre schede). */
export function setPersonalRecommendations(on: boolean): void {
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

/** Hook reattivo: true quando i consigli personalizzati sono accesi. */
export function usePersonalRecommendations(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
