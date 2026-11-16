// @polsia:user-owned — tempi parola per parola (Enhanced LRC) nel parser dei testi: i tag
// "<mm:ss.xx>" diventano `words` sulle righe con un tempo solo e almeno due parole (testo prima del
// primo tag col tempo della riga, tempi mai all'indietro, offset applicato, tetto di parole), il
// testo della riga resta pulito, le righe con più tempi o il testo semplice non hanno parole;
// parola attiva; il contratto del player accetta le parole e rifiuta gli eccessi.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LyricsLineSchema, LyricsSchema } from '@/lib/contracts/lyrics';
import {
  activeLyricsWord,
  LYRICS_MAX_WORDS_PER_LINE,
  lyricsFromSyncText,
  parseLyrics,
} from '@/lib/music/lyrics';

const KARAOKE = [
  '[00:12.30] <00:12.30>Prima <00:12.80>strofa <00:13.40>cantata',
  '[00:20.00] <00:20.00>Ritornello <00:20.90>intero',
  '[00:28.00] Riga senza parole',
].join('\n');

describe('parseLyrics: parole con tempo', () => {
  it('legge i tag delle parole e lascia il testo pulito', () => {
    const parsed = parseLyrics(KARAOKE);
    expect(parsed?.kind).toBe('synced');
    expect(parsed?.lines).toEqual([
      {
        timeMs: 12_300,
        text: 'Prima strofa cantata',
        words: [
          { timeMs: 12_300, text: 'Prima' },
          { timeMs: 12_800, text: 'strofa' },
          { timeMs: 13_400, text: 'cantata' },
        ],
      },
      {
        timeMs: 20_000,
        text: 'Ritornello intero',
        words: [
          { timeMs: 20_000, text: 'Ritornello' },
          { timeMs: 20_900, text: 'intero' },
        ],
      },
      { timeMs: 28_000, text: 'Riga senza parole' },
    ]);
  });

  it('testo prima del primo tag col tempo della riga; tempi mai all’indietro; gruppi di parole', () => {
    const parsed = parseLyrics('[00:05.00] Intro <00:06.00>poi due parole <00:05.50>indietro');
    expect(parsed?.lines[0]).toEqual({
      timeMs: 5000,
      text: 'Intro poi due parole indietro',
      words: [
        { timeMs: 5000, text: 'Intro' },
        { timeMs: 6000, text: 'poi due parole' },
        { timeMs: 6000, text: 'indietro' },
      ],
    });
  });

  it('applica [offset:] anche alle parole', () => {
    const parsed = parseLyrics('[offset:+500]\n[00:10.00] <00:10.00>A <00:11.00>B');
    expect(parsed?.lines[0]).toEqual({
      timeMs: 9500,
      text: 'A B',
      words: [
        { timeMs: 9500, text: 'A' },
        { timeMs: 10_500, text: 'B' },
      ],
    });
  });

  it('nessuna parola con un solo tag, su righe con più tempi, nel testo semplice o nelle pause', () => {
    expect(parseLyrics('[00:01.00] <00:01.00>Sola')?.lines[0]).toEqual({
      timeMs: 1000,
      text: 'Sola',
    });
    const repeated = parseLyrics(
      '[00:10.00][00:50.00] <00:10.00>Rit <00:10.50>ornello\n[00:30.00] Strofa',
    );
    expect(repeated?.lines.every((line) => line.words === undefined)).toBe(true);
    expect(repeated?.lines.map((line) => line.text)).toEqual([
      'Rit ornello',
      'Strofa',
      'Rit ornello',
    ]);
    expect(parseLyrics('<00:01.00>Testo <00:02.00>semplice')?.lines[0]).toEqual({
      timeMs: null,
      text: 'Testo semplice',
    });
    // Una pausa con soli tag resta una pausa, senza parole.
    expect(parseLyrics('[00:01.00] Canto\n[00:03.00] <00:03.00> <00:04.00>')?.lines[1]).toEqual({
      timeMs: 3000,
      text: '♪',
    });
    // SYLT non ha tag di parole.
    const sylt = lyricsFromSyncText([
      { text: '<00:01.00>a <00:02.00>b', timestamp: 1000 },
      { text: 'c', timestamp: 2000 },
    ]);
    expect(sylt?.lines[0]?.words).toBeUndefined();
    expect(sylt?.lines[0]?.text).toBe('a b');
  });

  it('tetto di parole per riga e tag malformati ignorati', () => {
    const many = Array.from(
      { length: 300 },
      (_, i) =>
        `<00:${String(10 + Math.floor(i / 60)).padStart(2, '0')}.${String(i % 60).padStart(2, '0')}>p${i}`,
    ).join(' ');
    const parsed = parseLyrics(`[00:10.00] ${many}`);
    expect(parsed?.lines[0]?.words).toHaveLength(LYRICS_MAX_WORDS_PER_LINE);
    expect(parsed?.lines[0]?.text.startsWith('p0 p1 p2')).toBe(true);
    const odd = parseLyrics('[00:10.00] <00:10.00>ok <99:99.99>strano <00:11.00>fine');
    // Il tag non valido (secondi 99) resta un tag letto senza tempo: la parola prende il tempo precedente.
    expect(odd?.lines[0]?.words).toEqual([
      { timeMs: 10_000, text: 'ok' },
      { timeMs: 10_000, text: 'strano' },
      { timeMs: 11_000, text: 'fine' },
    ]);
  });
});

describe('activeLyricsWord', () => {
  it('ultima parola con tempo ≤ ora, -1 prima della prima', () => {
    const words = [
      { timeMs: 1000, text: 'a' },
      { timeMs: 1500, text: 'b' },
      { timeMs: 2200, text: 'c' },
    ];
    expect(activeLyricsWord(words, 0)).toBe(-1);
    expect(activeLyricsWord(words, 1000)).toBe(0);
    expect(activeLyricsWord(words, 1499)).toBe(0);
    expect(activeLyricsWord(words, 1500)).toBe(1);
    expect(activeLyricsWord(words, 9000)).toBe(2);
    expect(activeLyricsWord([], 10)).toBe(-1);
  });
});

describe('contratto dei testi', () => {
  it('accetta le parole del parser e rifiuta una sola parola o troppe', () => {
    const parsed = parseLyrics(KARAOKE);
    const lyrics = LyricsSchema.parse({
      kind: 'synced',
      lines: parsed?.lines,
      source: 'featured',
      credit: null,
    });
    expect(lyrics.lines[0]?.words).toHaveLength(3);
    expect(lyrics.lines[2]?.words).toBeUndefined();
    expect(
      LyricsLineSchema.safeParse({ timeMs: 1, text: 'x', words: [{ timeMs: 1, text: 'x' }] })
        .success,
    ).toBe(false);
    const tooMany = Array.from({ length: LYRICS_MAX_WORDS_PER_LINE + 1 }, (_, i) => ({
      timeMs: i,
      text: 'w',
    }));
    expect(LyricsLineSchema.safeParse({ timeMs: 1, text: 'x', words: tooMany }).success).toBe(
      false,
    );
    expect(
      LyricsLineSchema.safeParse({
        timeMs: 1,
        text: 'x',
        words: [
          { timeMs: 1, text: '' },
          { timeMs: 2, text: 'b' },
        ],
      }).success,
    ).toBe(false);
  });
});
