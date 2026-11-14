// @polsia:user-owned — velocità di riproduzione "slowed / sped up", lato client, per dispositivo.
//
// La peculiarità del sito: rallentare o accelerare un brano cambiando ANCHE il tono (preservesPitch
// = false), l'estetica "slowed + reverb" / "sped up / nightcore". Vale per gli stream HTML5 (Audius,
// album Solco, radio, podcast, Jamendo, upload). Su YouTube l'iframe accetta solo velocità discrete
// e mantiene il tono, quindi lì l'effetto è solo di tempo (vedi nearestYouTubeRate).
//
// Salvata in localStorage; ogni scheda/componente si aggiorna tramite un evento di finestra. Stessa
// forma di data-saver.ts.
'use client';

import { useSyncExternalStore } from 'react';

const KEY = 'solco:playback-speed';
const EVENT = 'solco:playback-speed-changed';

export const DEFAULT_SPEED = 1;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
/** Preset mostrati nel player: rallentato → normale → accelerato. */
export const PLAYBACK_SPEEDS = [0.8, 0.9, 1, 1.25, 1.5] as const;

/** Riporta un valore nell'intervallo consentito; 1× per valori non validi. */
export function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, value));
}

function read(): number {
  if (typeof window === 'undefined') return DEFAULT_SPEED;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_SPEED;
    return clampSpeed(Number.parseFloat(raw));
  } catch {
    return DEFAULT_SPEED;
  }
}

/** Velocità corrente (1 lato server o se lo storage non è disponibile). */
export function getPlaybackSpeed(): number {
  return read();
}

/** Imposta la velocità (ritagliata all'intervallo) e avvisa gli ascoltatori. */
export function setPlaybackSpeed(value: number): void {
  const next = clampSpeed(value);
  try {
    window.localStorage.setItem(KEY, String(next));
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

/** Hook reattivo: la velocità scelta (1 = normale). */
export function usePlaybackSpeed(): number {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_SPEED);
}

/** La parte di HTMLMediaElement che tocchiamo per la velocità (in prova basta un oggetto finto). */
export type SpeedElement = {
  playbackRate: number;
  defaultPlaybackRate: number;
  preservesPitch?: boolean;
};

/**
 * Applica la velocità a un elemento <audio>. preservesPitch=false dà l'effetto "slowed/sped up"
 * (il tono scende quando rallenti, sale quando acceleri). Impostiamo anche defaultPlaybackRate
 * perché load() riporta playbackRate a quel valore: così dopo ogni nuova sorgente la velocità resta.
 */
export function applyElementSpeed(element: SpeedElement | null | undefined, speed: number): void {
  if (!element) return;
  const rate = clampSpeed(speed);
  try {
    // preservesPitch standard + prefissi storici (Safari < 17, vecchi Chromium/Firefox).
    const prefixed = element as SpeedElement & Record<string, unknown>;
    prefixed.preservesPitch = false;
    prefixed.webkitPreservesPitch = false;
    prefixed.mozPreservesPitch = false;
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
  } catch {
    // Alcuni ambienti non permettono di scrivere playbackRate su un elemento non pronto: si ignora.
  }
}

const YOUTUBE_DEFAULT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * YouTube accetta solo una lista discreta di velocità e mantiene il tono: scegliamo la più vicina a
 * quella desiderata (l'effetto su YouTube è solo di tempo, non di tono).
 */
export function nearestYouTubeRate(speed: number, available?: readonly number[]): number {
  const rates = available && available.length > 0 ? available : YOUTUBE_DEFAULT_RATES;
  let best = rates[0] ?? DEFAULT_SPEED;
  let bestDelta = Math.abs(best - speed);
  for (const rate of rates) {
    const delta = Math.abs(rate - speed);
    if (delta < bestDelta) {
      best = rate;
      bestDelta = delta;
    }
  }
  return best;
}
