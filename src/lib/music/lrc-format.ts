// @polsia:user-owned — formato dei tempi LRC: "[mm:ss.xx]" in testa a una riga e "<mm:ss.xx>" davanti
// a una parola (Enhanced LRC, karaoke nel player). Puro: lo usano la bozza di Solco AI (server) e
// l'allineamento del testo ufficiale; il parser dei testi (lyrics.ts) legge entrambe le forme.

/**
 * "mm:ss.xx" senza parentesi dall'inizio in secondi: centesimi arrotondati, minuti senza tetto (le
 * ore diventano minuti: 1 h 2 min 5 s → "62:05.00"). Valori non validi o negativi → "00:00.00";
 * oltre le 24 ore si ferma a 24 ore.
 */
export function formatLrcTime(seconds: number): string {
  const capped = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 24 * 3600) : 0;
  const total = Math.round(capped * 100);
  const minutes = Math.floor(total / 6000);
  const secs = Math.floor((total % 6000) / 100);
  const centiseconds = total % 100;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(minutes)}:${pad(secs)}.${pad(centiseconds)}`;
}

/** "[mm:ss.xx]" per la testa di una riga LRC. */
export function formatLrcTimestamp(seconds: number): string {
  return `[${formatLrcTime(seconds)}]`;
}

/** "<mm:ss.xx>" per il tag di una parola (Enhanced LRC). */
export function formatLrcWordTag(seconds: number): string {
  return `<${formatLrcTime(seconds)}>`;
}
