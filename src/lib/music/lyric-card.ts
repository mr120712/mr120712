// @polsia:user-owned — funzione Premium «Condividi una parte del testo»: parte pura (niente DOM né
// rete). Qui ci sono i LIMITI di quanto testo si può condividere (una PARTE scelta a piacimento, non
// tutto il brano), la scelta di un intervallo contiguo di righe, la didascalia della condivisione e
// il nome del file. Il testo arriva già dal pannello, dove esiste SOLO per i brani per cui Solco ha
// il diritto di mostrarlo (src/app/api/music/lyrics): questa funzione non aggiunge testi né tocca
// quel controllo, aggiunge solo la condivisione di un breve estratto con i crediti.

/** Righe massime di un estratto condivisibile: una parte (una strofa, un ritornello), non il brano. */
export const LYRIC_SHARE_MAX_LINES = 8;
/** Caratteri massimi dell'estratto, dopo aver tolto le righe vuote. */
export const LYRIC_SHARE_MAX_CHARS = 400;

/** I dati per comporre la scheda da condividere (nessun dato personale). */
export type LyricCardData = {
  /** Le righe dell'estratto scelto (già tagliate ai limiti, senza righe vuote ai bordi). */
  lines: string[];
  title: string;
  artist: string;
  /** Riga di credito del testo (es. «Testo: <titolare>»); null se non c'è. */
  credit: string | null;
};

/**
 * Intervallo contiguo di righe fra due tocchi (áncora e bersaglio), limitato a `maxLines` righe.
 * Tenendo l'estremo più in alto: se l'intervallo è troppo lungo si accorcia in basso.
 */
export function clampLineRange(
  anchor: number,
  target: number,
  maxLines: number = LYRIC_SHARE_MAX_LINES,
): { start: number; end: number } {
  const lo = Math.min(anchor, target);
  const hi = Math.max(anchor, target);
  const limit = Math.max(1, Math.floor(maxLines));
  return { start: lo, end: Math.min(hi, lo + limit - 1) };
}

/** Lunghezza dell'estratto in caratteri (righe unite da un a capo), per il limite. */
export function excerptCharCount(lines: string[]): number {
  return lines.join('\n').length;
}

/**
 * Tiene le righe dell'estratto entro i limiti: toglie le righe vuote ai bordi, poi scarta le righe
 * finali finché rientra in LYRIC_SHARE_MAX_CHARS (ne resta sempre almeno una). `truncated`: è stato
 * tagliato qualcosa per rispettare il limite.
 */
export function fitExcerpt(
  rawLines: string[],
  maxLines: number = LYRIC_SHARE_MAX_LINES,
  maxChars: number = LYRIC_SHARE_MAX_CHARS,
): { lines: string[]; truncated: boolean } {
  // Via gli spazi ai bordi e le righe vuote in testa e in coda (le interne restano come respiro).
  const trimmed = rawLines.map((line) => line.trim());
  let startIndex = 0;
  let endIndex = trimmed.length;
  while (startIndex < endIndex && trimmed[startIndex] === '') startIndex += 1;
  while (endIndex > startIndex && trimmed[endIndex - 1] === '') endIndex -= 1;
  const core = trimmed.slice(startIndex, endIndex);
  if (core.length === 0) return { lines: [], truncated: false };

  const limit = Math.max(1, Math.floor(maxLines));
  let lines = core.slice(0, limit);
  let truncated = lines.length < core.length;
  while (lines.length > 1 && excerptCharCount(lines) > maxChars) {
    lines = lines.slice(0, -1);
    truncated = true;
  }
  return { lines, truncated };
}

/** C'è un estratto condivisibile? (almeno una riga non vuota). */
export function hasShareableExcerpt(rawLines: string[]): boolean {
  return rawLines.some((line) => line.trim() !== '');
}

/** Didascalia della condivisione: solo brano e artista + invito, MAI il testo (che sta nell'immagine). */
export function shareCaption(title: string, artist: string): string {
  const song = title.trim() || 'Questo brano';
  const who = artist.trim();
  const head = who ? `«${song}» di ${who}` : `«${song}»`;
  return `${head} — il mio pezzo preferito del testo, su Solco 🎧`;
}

/** Nome del file dell'immagine condivisa. */
export function cardFileName(title: string): string {
  const base = slugify(title);
  return `solco-testo${base ? `-${base}` : ''}.png`;
}

/** Testo in forma breve per un nome di file: minuscolo, solo lettere/numeri, trattini, max 40. */
export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      // Toglie i segni diacritici combinanti (categoria Unicode «Mark»): «città» → «citta».
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '')
  );
}

/**
 * Manda a capo un testo entro `maxWidth` usando la funzione `measure` (larghezza in pixel di una
 * stringa). Pura: `measure` la fornisce il canvas (o un finto nei test). Una parola più larga del
 * limite resta su una riga da sola (meglio che perderla).
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
