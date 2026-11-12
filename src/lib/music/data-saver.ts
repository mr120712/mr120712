// @polsia:user-owned — preferenza "Risparmio dati" (lato client, per dispositivo).
//
// Quando è attiva, il player NON precarica in anticipo l'audio del brano successivo (il deck di
// riserva/gapless): si consuma meno rete, al prezzo di una pausa minima al cambio brano. Non
// cambia la qualità (le fonti di Solco hanno una sola qualità) né ferma la riproduzione corrente.
// Salvata in localStorage; ogni scheda/componente si aggiorna tramite un evento di finestra.
'use client';

import { useSyncExternalStore } from 'react';

const KEY = 'solco:data-saver';
const EVENT = 'solco:data-saver-changed';

function read(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Stato corrente del Risparmio dati (false lato server o se lo storage non è disponibile). */
export function getDataSaver(): boolean {
  return read();
}

/** Imposta la preferenza e avvisa gli ascoltatori (altri componenti, altre schede). */
export function setDataSaver(on: boolean): void {
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

/** Hook reattivo: true quando il Risparmio dati è attivo. */
export function useDataSaver(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
