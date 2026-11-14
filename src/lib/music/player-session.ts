// @polsia:user-owned — il player e l'account: uscendo, la musica si ferma e la coda salvata su
// questo dispositivo viene dimenticata. Prima la coda sopravviveva al logout: alla pagina successiva
// il mini player ricompariva col brano dell'utente appena uscito (sembrava che la musica
// continuasse, e su un dispositivo condiviso chi entrava dopo vedeva cosa ascoltavi).
'use client';

import { signOut } from '@/lib/auth-client';

/** Chiave della coda salvata del player (localStorage). */
export const PLAYER_STORAGE_KEY = 'solco.player.v1';

/** Evento di finestra: il player si ferma subito (lo ascolta MusicPlayerProvider). */
export const STOP_PLAYER_EVENT = 'solco:stop-player';

/** Messaggio per un'uscita non riuscita (rete assente o server irraggiungibile). */
export const SIGN_OUT_FAILED_MESSAGE =
  'Uscita non riuscita: controlla la connessione e riprova. La musica è stata fermata.';

/**
 * Ferma il player, dimentica la coda salvata e svuota i controlli della schermata di blocco /
 * notifica. Sicuro anche se il player non è montato: lo storage e la Media Session si puliscono
 * comunque.
 */
export function stopPlayerAndForget(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(STOP_PLAYER_EVENT));
  } catch {
    // Ambiente senza Event: si prosegue con la pulizia.
  }
  try {
    window.localStorage.removeItem(PLAYER_STORAGE_KEY);
  } catch {
    // Storage non disponibile: niente da cancellare.
  }
  try {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  } catch {
    // Media Session non supportata.
  }
}

/**
 * Uscita dall'account per i pulsanti "Esci": musica ferma e coda dimenticata SUBITO, poi logout e
 * navigazione completa (la pagina nuova parte pulita). Se il logout non riesce (rete), resta sulla
 * pagina e restituisce false: chi chiama lo dice all'utente, invece di fargli credere di essere
 * uscito su un dispositivo che magari lascia ad altri. `navigate` è sostituibile nei test.
 */
export async function signOutAndStopMusic(
  destination: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<boolean> {
  stopPlayerAndForget();
  let ok = false;
  try {
    const result: unknown = await signOut();
    ok = !(result && typeof result === 'object' && (result as { error?: unknown }).error);
  } catch {
    ok = false;
  }
  if (ok) navigate(destination);
  return ok;
}
