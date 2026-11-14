// @polsia:user-owned — "Autoplay continuo", lato client, per dispositivo.
//
// Quando la coda finisce (e non c'è ripetizione), con l'autoplay ACCESO Solco prosegue da solo con
// brani consigliati da una fonte LECITA già presente (Audius trending, riproducibile sotto la Open
// Music License). Così la musica non si ferma a schermo bloccato senza toccare il telefono. Default
// SPENTO: è una scelta esplicita (consuma rete). Niente YouTube/terzi: solo brani Audius idonei.
//
// Lo stato è salvato in localStorage e condiviso tra schede/componenti con un evento di finestra
// (stessa forma di playback-speed.ts). La selezione dei candidati è una funzione pura, testabile.
'use client';

import { useSyncExternalStore } from 'react';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';

const KEY = 'solco:autoplay';
const EVENT = 'solco:autoplay-changed';

/** Quanti brani consigliati accodare a ogni continuazione. */
export const AUTOPLAY_BATCH = 20;

function read(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Stato corrente dell'autoplay (false lato server o se lo storage non è disponibile). */
export function getAutoplay(): boolean {
  return read();
}

/** Accende/spegne l'autoplay e avvisa gli ascoltatori. */
export function setAutoplay(value: boolean): void {
  try {
    window.localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // Storage non disponibile (private, bloccato): resta solo in memoria di questa scheda.
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

/** Hook reattivo: true se l'autoplay è acceso su questo dispositivo. */
export function useAutoplay(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

/**
 * Sceglie i prossimi brani da accodare: solo quelli idonei alla riproduzione e non ancora visti
 * (niente ripetizioni immediate), fino a `batch`. Pura e testabile; il player fa poi la mappatura
 * a traccia del player e li fa partire con playTrack.
 */
export function selectAutoplayCandidates(
  tracks: readonly AudiusTrackSearchResult[],
  seen: ReadonlySet<string>,
  batch: number = AUTOPLAY_BATCH,
): AudiusTrackSearchResult[] {
  const out: AudiusTrackSearchResult[] = [];
  const used = new Set<string>();
  for (const track of tracks) {
    if (out.length >= batch) break;
    if (!track.playbackEligible) continue;
    if (seen.has(track.qualifiedId) || used.has(track.qualifiedId)) continue;
    used.add(track.qualifiedId);
    out.push(track);
  }
  return out;
}
