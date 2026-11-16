// @polsia:user-owned — parser dei testi (lyrics.ts): tutte le varianti LRC, offset, ordinamento,
// tetti, input malevolo, testo semplice, SYLT, normalizzazione dell'input degli upload e riga
// attiva.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  activeLyricsLine,
  LYRICS_INSTRUMENTAL,
  LYRICS_MAX_LINE_CHARS,
  LYRICS_MAX_LINES,
  lyricsFromSyncText,
  normalizeLyricsInput,
  parseLyrics,
  sanitizeLyricsLine,
} from '@/lib/music/lyrics';

const ch = (code: number) => String.fromCharCode(code);

describe('parseLyrics: LRC sincronizzato', () => {
  it('riconosce [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx]', () => {
    const parsed = parseLyrics(
      ['[00:01]Uno', '[00:02.5]Due', '[00:03.25]Tre', '[01:04.125]Quattro'].join('\n'),
    );
    expect(parsed).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 1000, text: 'Uno' },
        { timeMs: 2500, text: 'Due' },
        { timeMs: 3250, text: 'Tre' },
        { timeMs: 64_125, text: 'Quattro' },
      ],
    });
  });

  it('più tempi sulla stessa riga diventano più righe, ordinate per tempo', () => {
    const parsed = parseLyrics('[00:30.00]Strofa\n[00:10.00][00:50.00]Ritornello');
    expect(parsed?.lines).toEqual([
      { timeMs: 10_000, text: 'Ritornello' },
      { timeMs: 30_000, text: 'Strofa' },
      { timeMs: 50_000, text: 'Ritornello' },
    ]);
  });

  it('ordina le righe fuori ordine (stabile a parità di tempo)', () => {
    const parsed = parseLyrics('[00:20.00]B\n[00:05.00]A\n[00:20.00]C');
    expect(parsed?.lines.map((line) => line.text)).toEqual(['A', 'B', 'C']);
  });

  it('applica [offset:] (positivo = prima, negativo = dopo) senza scendere sotto zero', () => {
    expect(parseLyrics('[offset:+500]\n[00:01.00]Uno\n[00:00.20]Zero')?.lines).toEqual([
      { timeMs: 0, text: 'Zero' },
      { timeMs: 500, text: 'Uno' },
    ]);
    expect(parseLyrics('[offset:-250]\n[00:01.00]Uno')?.lines).toEqual([
      { timeMs: 1250, text: 'Uno' },
    ]);
    // Offset malformato: ignorato.
    expect(parseLyrics('[offset:abc]\n[00:01.00]Uno')?.lines[0]?.timeMs).toBe(1000);
  });

  it('ignora i tag di metadati e toglie i tag parola per parola (Enhanced LRC)', () => {
    const parsed = parseLyrics(
      [
        '[ar:Artista]',
        '[ti:Titolo]',
        '[al:Album]',
        '[length: 03:45]',
        '[by:Qualcuno]',
        '[00:01.00]<00:01.00>Ciao <00:01.50>mondo',
      ].join('\n'),
    );
    // I tag delle parole non restano nel testo: diventano i tempi delle parole (karaoke).
    expect(parsed).toEqual({
      kind: 'synced',
      lines: [
        {
          timeMs: 1000,
          text: 'Ciao mondo',
          words: [
            { timeMs: 1000, text: 'Ciao' },
            { timeMs: 1500, text: 'mondo' },
          ],
        },
      ],
    });
  });

  it('le righe temporizzate vuote sono pause strumentali (♪), unite se consecutive', () => {
    const parsed = parseLyrics(
      '[00:00.00]\n[00:05.00]Canto\n[00:10.00]\n[00:12.00]\n[00:20.00]Fine',
    );
    expect(parsed?.lines).toEqual([
      { timeMs: 0, text: LYRICS_INSTRUMENTAL },
      { timeMs: 5000, text: 'Canto' },
      { timeMs: 10_000, text: LYRICS_INSTRUMENTAL },
      { timeMs: 20_000, text: 'Fine' },
    ]);
  });

  it('solo pause strumentali: nessun testo', () => {
    expect(parseLyrics('[00:01.00]\n[00:02.00]')).toBeNull();
  });

  it('righe miste: sincronizzato se la maggioranza ha un tempo (le altre si scartano)', () => {
    const parsed = parseLyrics('[00:01.00]Uno\n[00:02.00]Due\nSenza tempo');
    expect(parsed?.kind).toBe('synced');
    expect(parsed?.lines.map((line) => line.text)).toEqual(['Uno', 'Due']);
  });

  it('righe miste in minoranza: testo semplice, senza i tempi', () => {
    const parsed = parseLyrics('Prima\nSeconda\n[00:03.00]Terza');
    expect(parsed).toEqual({
      kind: 'plain',
      lines: [
        { timeMs: null, text: 'Prima' },
        { timeMs: null, text: 'Seconda' },
        { timeMs: null, text: 'Terza' },
      ],
    });
  });

  it('a capo Windows/Mac e BOM iniziale', () => {
    const parsed = parseLyrics(`${ch(0xfeff)}[00:01.00]Uno\r\n[00:02.00]Due\r[00:03.00]Tre`);
    expect(parsed?.lines.map((line) => line.text)).toEqual(['Uno', 'Due', 'Tre']);
  });

  it('tempi impossibili (secondi ≥ 60) non valgono', () => {
    const parsed = parseLyrics('[00:75.00]Errato\n[00:01.00]Giusto\n[00:02.00]Altro');
    expect(parsed?.lines.map((line) => line.text)).toEqual(['Giusto', 'Altro']);
  });
});

describe('parseLyrics: testo semplice', () => {
  it('mantiene una riga vuota fra le strofe, niente vuoti in testa o in coda', () => {
    const parsed = parseLyrics('\n\nStrofa uno\nancora\n\n\n\nStrofa due\n\n');
    expect(parsed).toEqual({
      kind: 'plain',
      lines: [
        { timeMs: null, text: 'Strofa uno' },
        { timeMs: null, text: 'ancora' },
        { timeMs: null, text: '' },
        { timeMs: null, text: 'Strofa due' },
      ],
    });
  });

  it('una riga [Ritornello] senza due punti resta testo', () => {
    expect(parseLyrics('[Ritornello]\nLa la la')?.lines.map((line) => line.text)).toEqual([
      '[Ritornello]',
      'La la la',
    ]);
  });

  it('vuoto, solo spazi, solo metadati o non una stringa: null', () => {
    expect(parseLyrics('')).toBeNull();
    expect(parseLyrics('   \n\t\n')).toBeNull();
    expect(parseLyrics('[ar:Artista]\n[ti:Titolo]')).toBeNull();
    expect(parseLyrics(null)).toBeNull();
    expect(parseLyrics(undefined)).toBeNull();
    expect(parseLyrics(42 as unknown as string)).toBeNull();
  });
});

describe('parseLyrics: input malevolo e tetti', () => {
  it('toglie caratteri di controllo, override bidi e invisibili; comprime gli spazi', () => {
    const dirty = `Ciao${ch(0x202e)}${ch(0x0007)}  ${ch(0x200b)}mondo${ch(0x2066)}\tqui${ch(0xfeff)}`;
    expect(parseLyrics(dirty)?.lines).toEqual([{ timeMs: null, text: 'Ciao mondo qui' }]);
    expect(sanitizeLyricsLine(`a${ch(0x0000)}b${ch(0x009b)}c`)).toBe('abc');
  });

  it('il markup resta testo (React lo mostra come tale)', () => {
    expect(parseLyrics('<script>alert(1)</script>')?.lines[0]?.text).toBe(
      '<script>alert(1)</script>',
    );
  });

  it(`al massimo ${LYRICS_MAX_LINES} righe e ${LYRICS_MAX_LINE_CHARS} caratteri per riga`, () => {
    const many = Array.from({ length: 5000 }, (_, index) => `Riga ${index}`).join('\n');
    expect(parseLyrics(many)?.lines).toHaveLength(LYRICS_MAX_LINES);
    const timed = Array.from(
      { length: 3000 },
      (_, index) =>
        `[${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.00]R${index}`,
    ).join('\n');
    const parsedTimed = parseLyrics(timed);
    expect(parsedTimed?.lines).toHaveLength(LYRICS_MAX_LINES);
    // Si tengono le PRIME righe nel tempo.
    expect(parsedTimed?.lines[0]?.text).toBe('R0');
    const long = parseLyrics('x'.repeat(5000));
    expect([...(long?.lines[0]?.text ?? '')]).toHaveLength(LYRICS_MAX_LINE_CHARS);
  });

  it('migliaia di tempi su una riga e input enormi: veloce e limitato', () => {
    const tags = '[00:01.00]'.repeat(50_000);
    const started = Date.now();
    const parsed = parseLyrics(`${tags}Eco`);
    expect(parsed?.kind).toBe('synced');
    expect(parsed?.lines.length).toBeLessThanOrEqual(LYRICS_MAX_LINES);
    const huge = parseLyrics('a'.repeat(3_000_000));
    expect(huge?.lines[0]?.text.length).toBe(LYRICS_MAX_LINE_CHARS);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('tempi oltre le 24 ore e minuti a 4 cifre non valgono', () => {
    const parsed = parseLyrics(
      '[1500:00.00]Lontano\n[9999:00]Troppo\n[00:01.00]Vicino\n[00:02]Due',
    );
    expect(parsed?.lines.map((line) => line.text)).toEqual(['Vicino', 'Due']);
  });
});

describe('lyricsFromSyncText (SYLT)', () => {
  it('una voce per riga', () => {
    expect(
      lyricsFromSyncText([
        { text: 'Seconda', timestamp: 2000 },
        { text: 'Prima', timestamp: 1000 },
      ]),
    ).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 1000, text: 'Prima' },
        { timeMs: 2000, text: 'Seconda' },
      ],
    });
  });

  it('sillabe: le voci con "\\n" iniziale aprono una riga, le altre si attaccano', () => {
    expect(
      lyricsFromSyncText([
        { text: 'Cia', timestamp: 1000 },
        { text: 'o', timestamp: 1200 },
        { text: '\nmon', timestamp: 3000 },
        { text: 'do', timestamp: 3300 },
      ])?.lines,
    ).toEqual([
      { timeMs: 1000, text: 'Ciao' },
      { timeMs: 3000, text: 'mondo' },
    ]);
  });

  it('una riga per voce con "\\n" (o "\\r\\n") in CODA: righe separate, non una sola', () => {
    const expected = [
      { timeMs: 1000, text: 'Prima riga' },
      { timeMs: 4000, text: 'Seconda riga' },
      { timeMs: 8000, text: 'Terza riga' },
    ];
    for (const end of ['\n', '\r\n']) {
      expect(
        lyricsFromSyncText([
          { text: `Prima riga${end}`, timestamp: 1000 },
          { text: `Seconda riga${end}`, timestamp: 4000 },
          { text: `Terza riga${end}`, timestamp: 8000 },
        ]),
      ).toEqual({ kind: 'synced', lines: expected });
    }
    // Sillabe con l'a capo in coda all'ultima della riga.
    expect(
      lyricsFromSyncText([
        { text: 'Cia', timestamp: 1000 },
        { text: 'o\n', timestamp: 1200 },
        { text: 'mon', timestamp: 3000 },
        { text: 'do\n', timestamp: 3300 },
      ])?.lines,
    ).toEqual([
      { timeMs: 1000, text: 'Ciao' },
      { timeMs: 3000, text: 'mondo' },
    ]);
  });

  it('una voce di soli a capo chiude la riga, senza pause strumentali finte', () => {
    expect(
      lyricsFromSyncText([
        { text: 'Cia', timestamp: 1000 },
        { text: 'o', timestamp: 1200 },
        { text: '\n', timestamp: 2000 },
        { text: 'mon', timestamp: 3000 },
        { text: 'do', timestamp: 3300 },
        { text: '\r\n', timestamp: 3900 },
      ])?.lines,
    ).toEqual([
      { timeMs: 1000, text: 'Ciao' },
      { timeMs: 3000, text: 'mondo' },
    ]);
  });

  it('tempi non validi scartati; niente voci → null', () => {
    expect(lyricsFromSyncText([{ text: 'x', timestamp: -1 }, { text: 'y' }])).toBeNull();
    expect(lyricsFromSyncText([])).toBeNull();
    expect(lyricsFromSyncText(null)).toBeNull();
  });
});

describe('normalizeLyricsInput', () => {
  it('BOM, a capo, tab, controlli e righe vuote multiple', () => {
    expect(
      normalizeLyricsInput(`${ch(0xfeff)}\r\n  Uno  \r\n\r\n\r\n\tDue${ch(0x202e)}\r\n\r\n`),
    ).toBe('Uno\n\n Due');
  });
});

describe('activeLyricsLine', () => {
  const lines = [
    { timeMs: 1000, text: 'a' },
    { timeMs: 2000, text: 'b' },
    { timeMs: 3000, text: 'c' },
  ];
  it('l’ultima riga già iniziata, -1 prima della prima', () => {
    expect(activeLyricsLine(lines, 0)).toBe(-1);
    expect(activeLyricsLine(lines, 999)).toBe(-1);
    expect(activeLyricsLine(lines, 1000)).toBe(0);
    expect(activeLyricsLine(lines, 2500)).toBe(1);
    expect(activeLyricsLine(lines, 99_000)).toBe(2);
    expect(activeLyricsLine([], 1000)).toBe(-1);
  });
});
