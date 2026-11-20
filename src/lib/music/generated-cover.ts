// @polsia:user-owned — copertina generata deterministica (gradiente + iniziali) per i brani senza
// immagine. È l'ultimo anello della catena delle copertine in evidenza: immagine omonima → copertina
// di cartella → artwork incorporato → QUESTA. Puro e senza rete: lo stesso testo dà sempre la stessa
// copertina (nessun flicker, nessun mismatch di diritti, niente chiamate esterne o AI). La usa
// FallbackArt quando non c'è un'immagine da mostrare.
import { artInitial } from '@/lib/music/art-initial';

/** Hash deterministico (djb2) di una stringa → intero a 32 bit non negativo. */
function hashSeed(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Fino a 2 iniziali leggibili: la prima lettera della prima e dell'ultima parola «vera» del testo
 * (es. «Zitti e Buoni» → «ZB», «Alba» → «A»). Grafemi interi (emoji/accenti al sicuro, via artInitial).
 * Testo vuoto → il segnaposto ♪.
 */
export function coverInitials(label: string | null | undefined): string {
  const words = (label ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return artInitial(label);
  const first = artInitial(words[0]);
  if (words.length === 1) return first;
  return `${first}${artInitial(words[words.length - 1])}`;
}

/**
 * Gradiente CSS deterministico dal seme: due tinte vicine (armoniche), con saturazione e luminosità
 * controllate così che le iniziali bianche restino leggibili su qualsiasi tinta, in tema chiaro e
 * scuro. Stesso seme → stesso gradiente.
 */
export function coverGradient(seed: string | null | undefined): string {
  const hue = hashSeed((seed ?? '').trim() || '♪') % 360;
  const hue2 = (hue + 38) % 360;
  return `linear-gradient(135deg, hsl(${hue} 58% 45%), hsl(${hue2} 64% 34%))`;
}
