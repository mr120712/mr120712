// @polsia:user-owned
// @vitest-environment node
//
// Funzione Premium «Condividi una parte del testo» (src/lib/music/lyric-card.ts): i limiti
// dell'estratto (una PARTE, non tutto il brano), l'intervallo contiguo di righe, la didascalia
// (mai il testo) e il nome del file.
import { describe, expect, it } from 'vitest';
import {
  cardFileName,
  clampLineRange,
  excerptCharCount,
  fitExcerpt,
  hasShareableExcerpt,
  LYRIC_SHARE_MAX_CHARS,
  LYRIC_SHARE_MAX_LINES,
  shareCaption,
  slugify,
  wrapText,
} from '@/lib/music/lyric-card';

describe('intervallo contiguo di righe', () => {
  it('ordina gli estremi e tiene al massimo LYRIC_SHARE_MAX_LINES righe', () => {
    expect(clampLineRange(2, 5)).toEqual({ start: 2, end: 5 });
    expect(clampLineRange(5, 2)).toEqual({ start: 2, end: 5 });
    expect(clampLineRange(0, 0)).toEqual({ start: 0, end: 0 });
    // Oltre il limite: si accorcia in basso.
    expect(clampLineRange(0, 100, LYRIC_SHARE_MAX_LINES)).toEqual({
      start: 0,
      end: LYRIC_SHARE_MAX_LINES - 1,
    });
    expect(clampLineRange(3, 3, 4)).toEqual({ start: 3, end: 3 });
  });
});

describe('estratto entro i limiti', () => {
  it('toglie le righe vuote ai bordi e tiene al massimo le righe consentite', () => {
    const raw = ['', ' prima ', 'seconda', '', '  ', 'terza', ''];
    const { lines, truncated } = fitExcerpt(raw, 2);
    expect(lines).toEqual(['prima', 'seconda']);
    expect(truncated).toBe(true); // "terza" tagliata dal limite di righe
  });

  it('rispetta il limite di caratteri, lasciando sempre almeno una riga', () => {
    const long = 'x'.repeat(LYRIC_SHARE_MAX_CHARS + 50);
    const { lines, truncated } = fitExcerpt([long, 'altra riga']);
    expect(lines).toEqual([long]);
    expect(truncated).toBe(true);
  });

  it('niente righe utili: estratto vuoto', () => {
    expect(fitExcerpt(['', '   ', ''])).toEqual({ lines: [], truncated: false });
    expect(hasShareableExcerpt(['', ' '])).toBe(false);
    expect(hasShareableExcerpt(['', 'ciao'])).toBe(true);
  });

  it('conta i caratteri con gli a capo fra le righe', () => {
    expect(excerptCharCount(['ab', 'cd'])).toBe(5); // "ab\ncd"
  });
});

describe('didascalia e nome file', () => {
  it('la didascalia NON contiene il testo, solo brano e artista', () => {
    const caption = shareCaption('Titolo', 'Artista');
    expect(caption).toContain('«Titolo»');
    expect(caption).toContain('Artista');
    expect(caption).toContain('Solco');
  });

  it('senza artista resta leggibile', () => {
    expect(shareCaption('Solo', '  ')).toContain('«Solo»');
    expect(shareCaption('', '')).toContain('«Questo brano»');
  });

  it('slug e nome file sicuri', () => {
    expect(slugify('Città di Notte! (2024)')).toBe('citta-di-notte-2024');
    expect(slugify('   ')).toBe('');
    expect(cardFileName('Città di Notte')).toBe('solco-testo-citta-di-notte.png');
    expect(cardFileName('   ')).toBe('solco-testo.png');
  });
});

describe('a capo del testo', () => {
  it('manda a capo usando la larghezza misurata; una parola lunghissima resta da sola', () => {
    // Finto "measure": 1px per carattere.
    const measure = (text: string) => text.length;
    expect(wrapText('uno due tre', 7, measure)).toEqual(['uno due', 'tre']);
    expect(wrapText('parolalunghissima corta', 5, measure)).toEqual(['parolalunghissima', 'corta']);
    expect(wrapText('   ', 10, measure)).toEqual(['']);
  });
});
