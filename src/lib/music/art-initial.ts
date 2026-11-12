// @polsia:user-owned — iniziale mostrata al posto di una copertina mancante. Prende il primo
// carattere visibile intero (emoji, bandiere, lettere accentate), mai mezza coppia surrogata.
// Nessuna dipendenza client o server: la usano sia FallbackArt sia l'anteprima social.

const PLACEHOLDER = '♪';

function firstGrapheme(text: string): string | undefined {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter('it', { granularity: 'grapheme' }).segment(text);
    for (const { segment } of segments) return segment;
    return undefined;
  }
  return Array.from(text)[0];
}

export function artInitial(label: string | null | undefined): string {
  const first = firstGrapheme((label ?? '').trim());
  return first ? first.toLocaleUpperCase('it-IT') : PLACEHOLDER;
}
