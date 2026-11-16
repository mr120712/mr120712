// @polsia:user-owned — allineamento del testo ufficiale alle parole con tempo di Solco AI
// (lyrics-align.ts, puro): forma piegata e somiglianza; parole dalla bozza (Enhanced LRC o righe);
// allineamento perfetto, con refusi del modello, con parole in più nell'audio (allucinazioni) e
// con una strofa che manca (tempi interpolati, riga «senza riscontro»); tempi mai all'indietro;
// Enhanced LRC letto dal parser del player; LRC solo con i tempi delle righe quando la trascrizione
// non aveva le parole; rifiuti (testo vuoto, trascrizione vuota, troppo lungo, nessun riscontro).
import { describe, expect, it } from 'vitest';
import { formatLrcTime, formatLrcTimestamp, formatLrcWordTag } from '@/lib/music/lrc-format';
import { parseLyrics } from '@/lib/music/lyrics';
import {
  ALIGN_EDGE_STEP_MS,
  ALIGN_MAX_LYRICS_WORDS,
  alignLyrics,
  boundedEditDistance,
  foldWord,
  matchScore,
  type TimedWord,
  timedWordsFromLyrics,
  tokenizeLyricsLine,
} from '@/lib/music/lyrics-align';

/** Parole con tempo a passo fisso, come le darebbe Solco AI. */
function spoken(text: string, startMs = 12_000, stepMs = 400): TimedWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({ timeMs: startMs + index * stepMs, text: word }));
}

const OFFICIAL = ['Sotto il cielo di Roma', 'canto per te stasera', 'e la luna ci guarda'];

describe('forma piegata e somiglianza', () => {
  it('foldWord: minuscole, senza accenti, apostrofi e punteggiatura', () => {
    expect(foldWord('Perché,')).toBe('perche');
    expect(foldWord("L'amore!")).toBe('lamore');
    expect(foldWord('CITTÀ…')).toBe('citta');
    expect(foldWord('—')).toBe('');
  });

  it('boundedEditDistance: entro il limite esatta, oltre il limite max + 1', () => {
    expect(boundedEditDistance('cielo', 'celo', 2)).toBe(1);
    expect(boundedEditDistance('cielo', 'cielo', 1)).toBe(0);
    expect(boundedEditDistance('cielo', 'mare', 1)).toBe(2);
    expect(boundedEditDistance('abcdefg', 'abcdxyz', 2)).toBe(3);
  });

  it('matchScore: parole lunghe valgono più delle corte; quasi uguali solo da 4 lettere', () => {
    expect(matchScore('e', 'e')).toBe(6);
    expect(matchScore('per', 'per')).toBe(12);
    expect(matchScore('cielo', 'cielo')).toBe(20);
    expect(matchScore('cielo', 'celo')).toBe(14);
    expect(matchScore('stasera', 'staserra')).toBe(14);
    expect(matchScore('guardano', 'guardava')).toBe(10);
    expect(matchScore('te', 'me')).toBe(0);
    expect(matchScore('luna', 'lupa')).toBe(14);
    expect(matchScore('luna', 'sole')).toBe(0);
    expect(matchScore('', 'sole')).toBe(0);
  });

  it('tokenizeLyricsLine: spazi come separatori, testo già pulito', () => {
    expect(tokenizeLyricsLine('  Sotto   il cielo\tdi Roma ')).toEqual([
      'Sotto',
      'il',
      'cielo',
      'di',
      'Roma',
    ]);
  });
});

describe('parole con tempo dalla bozza di Solco AI', () => {
  it('Enhanced LRC: ogni parola col suo tempo, wordLevel true', () => {
    const draft = `[00:12.00] <00:12.00>Sotto <00:12.40>il <00:12.80>cielo\n[00:14.00] <00:14.00>canto <00:14.50>per <00:15.00>te`;
    const { words, wordLevel } = timedWordsFromLyrics(parseLyrics(draft));
    expect(wordLevel).toBe(true);
    expect(words).toEqual([
      { timeMs: 12_000, text: 'Sotto' },
      { timeMs: 12_400, text: 'il' },
      { timeMs: 12_800, text: 'cielo' },
      { timeMs: 14_000, text: 'canto' },
      { timeMs: 14_500, text: 'per' },
      { timeMs: 15_000, text: 'te' },
    ]);
  });

  it('LRC con i soli tempi delle righe: ogni parola col tempo della riga, wordLevel false; ♪ saltate', () => {
    const draft = '[00:12.00] Sotto il cielo\n[00:13.50] ♪\n[00:14.00] canto per te';
    const { words, wordLevel } = timedWordsFromLyrics(parseLyrics(draft));
    expect(wordLevel).toBe(false);
    expect(words.map((word) => [word.text, word.timeMs])).toEqual([
      ['Sotto', 12_000],
      ['il', 12_000],
      ['cielo', 12_000],
      ['canto', 14_000],
      ['per', 14_000],
      ['te', 14_000],
    ]);
  });

  it('testo semplice (nessun tempo) o nulla: nessuna parola', () => {
    expect(timedWordsFromLyrics(parseLyrics('Sotto il cielo\ncanto per te'))).toEqual({
      words: [],
      wordLevel: false,
    });
    expect(timedWordsFromLyrics(null)).toEqual({ words: [], wordLevel: false });
  });
});

describe('allineamento', () => {
  it('trascrizione perfetta: ogni parola col suo tempo, righe dalla prima parola, copertura 1', () => {
    const transcript = spoken('sotto il cielo di roma canto per te stasera e la luna ci guarda');
    const result = alignLyrics(OFFICIAL, transcript, { wordLevel: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats).toEqual({
      matchedWords: 14,
      totalWords: 14,
      coverage: 1,
      unmatchedLines: [],
    });
    expect(result.wordTimed).toBe(true);
    expect(result.lines.map((line) => line.timeMs)).toEqual([12_000, 14_000, 15_600]);
    expect(result.lines[0]?.words.map((word) => word.matched)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    // Le parole sono quelle del testo (maiuscole comprese), i tempi quelli dell'audio.
    expect(result.lrc.split('\n')[0]).toBe(
      `${formatLrcTimestamp(12)} ${formatLrcWordTag(12)}Sotto ${formatLrcWordTag(12.4)}il ${formatLrcWordTag(12.8)}cielo ${formatLrcWordTag(13.2)}di ${formatLrcWordTag(13.6)}Roma`,
    );
    const parsed = parseLyrics(result.lrc);
    expect(parsed?.kind).toBe('synced');
    expect(parsed?.lines.map((line) => line.text)).toEqual(OFFICIAL);
    expect(parsed?.lines[1]?.words?.map((word) => word.text)).toEqual([
      'canto',
      'per',
      'te',
      'stasera',
    ]);
  });

  it('refusi del modello: parola quasi uguale abbinata, parola corta diversa interpolata', () => {
    // «celo» per «cielo», «me» per «te».
    const transcript = spoken('sotto il celo di roma canto per me stasera e la luna ci guarda');
    const result = alignLyrics(OFFICIAL, transcript, { wordLevel: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats.matchedWords).toBe(13);
    expect(result.stats.totalWords).toBe(14);
    expect(result.stats.unmatchedLines).toEqual([]);
    const second = result.lines[1];
    expect(second?.words.map((word) => word.matched)).toEqual([true, true, false, true]);
    // «te» prende un tempo fra «per» (14.4 s) e «stasera» (15.2 s).
    expect(second?.words[2]?.timeMs).toBe(14_800);
    expect(second?.words[2]?.text).toBe('te');
  });

  it('parole in più nell’audio (allucinazione in coda): saltate, copertura intatta', () => {
    const transcript = spoken(
      'sotto il cielo di roma canto per te stasera e la luna ci guarda grazie per la visione',
    );
    const result = alignLyrics(OFFICIAL, transcript, { wordLevel: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats.coverage).toBe(1);
    expect(result.lines.map((line) => line.timeMs)).toEqual([12_000, 14_000, 15_600]);
  });

  it('una strofa che l’audio trascritto non ha: tempi interpolati fra le vicine, riga senza riscontro', () => {
    // La seconda riga manca nella trascrizione.
    const transcript = [
      ...spoken('sotto il cielo di roma', 12_000),
      ...spoken('e la luna ci guarda', 20_000),
    ];
    const result = alignLyrics(OFFICIAL, transcript, { wordLevel: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats.unmatchedLines).toEqual([2]);
    expect(result.stats.matchedWords).toBe(10);
    const [first, second, third] = result.lines;
    expect(first?.timeMs).toBe(12_000);
    expect(third?.timeMs).toBe(20_000);
    // Quattro parole fra «Roma» (13.6 s) e «e» (20 s): passo di (6400 / 5) ms.
    expect(second?.words.map((word) => word.timeMs)).toEqual([14_880, 16_160, 17_440, 18_720]);
    expect(second?.timeMs).toBe(14_880);
    expect(second?.words.every((word) => !word.matched)).toBe(true);
  });

  it('parole prima della prima abbinata e dopo l’ultima: un passo fisso, mai sotto zero né oltre la durata', () => {
    // «cielo» a 200 ms, poi una parola ogni 400 ms: «luna» (la decima) a 3800 ms.
    const transcript = spoken('cielo di roma canto per te stasera e la luna', 200);
    const result = alignLyrics(OFFICIAL, transcript, { wordLevel: true, durationMs: 4300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const words = result.lines.flatMap((line) => line.words);
    // «Sotto» e «il» prima di «cielo» (200 ms): a passi di ALIGN_EDGE_STEP_MS, fermi a 0.
    expect(words[0]?.timeMs).toBe(0);
    expect(words[1]?.timeMs).toBe(0);
    expect(words[2]?.timeMs).toBe(200);
    // «ci» e «guarda» dopo «luna» (3800 ms): un passo di 320 ms, poi il tetto della durata.
    expect(words.at(-2)?.timeMs).toBe(3800 + ALIGN_EDGE_STEP_MS);
    expect(words.at(-1)?.timeMs).toBe(4300);
  });

  it('i tempi delle righe non tornano mai indietro', () => {
    const result = alignLyrics(
      OFFICIAL,
      spoken('sotto il cielo di roma canto per te stasera e la luna ci guarda'),
      { wordLevel: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const times = result.lines.map((line) => line.timeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('trascrizione con i soli tempi delle righe: LRC senza tag delle parole, wordTimed false', () => {
    const transcript = spoken('sotto il cielo di roma canto per te stasera e la luna ci guarda');
    const result = alignLyrics(OFFICIAL, transcript, { wordLevel: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wordTimed).toBe(false);
    expect(result.lrc).not.toContain('<');
    expect(result.lrc.split('\n')).toEqual([
      `${formatLrcTimestamp(12)} Sotto il cielo di Roma`,
      `${formatLrcTimestamp(14)} canto per te stasera`,
      `${formatLrcTimestamp(15.6)} e la luna ci guarda`,
    ]);
    expect(formatLrcTime(15.6)).toBe('00:15.60');
  });

  it('righe vuote e pause ♪ nel testo si saltano; la punteggiatura resta nelle parole', () => {
    const result = alignLyrics(
      ['Sotto il cielo di Roma,', '', '♪', 'canto per te stasera!'],
      spoken('sotto il cielo di roma canto per te stasera'),
      { wordLevel: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => line.text)).toEqual([
      'Sotto il cielo di Roma,',
      'canto per te stasera!',
    ]);
    expect(result.stats.coverage).toBe(1);
    expect(result.lines[0]?.words.at(-1)?.text).toBe('Roma,');
  });

  it('ritornello ripetuto: l’ordine si rispetta, ogni ripetizione prende i suoi tempi', () => {
    const lines = ['Vieni via con me', 'resta qui', 'Vieni via con me'];
    const transcript = [
      ...spoken('vieni via con me', 10_000),
      ...spoken('resta qui', 20_000),
      ...spoken('vieni via con me', 30_000),
    ];
    const result = alignLyrics(lines, transcript, { wordLevel: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => line.timeMs)).toEqual([10_000, 20_000, 30_000]);
    expect(result.stats.coverage).toBe(1);
  });

  it('nessun riscontro (testo di un altro brano): rifiuto con le statistiche', () => {
    const result = alignLyrics(
      ['Nel blu dipinto di blu', 'felice di stare lassù'],
      spoken('sotto il cielo di roma canto per te stasera e la luna ci guarda'),
      { wordLevel: true },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_match');
    expect(result.stats?.totalWords).toBe(9);
    expect(result.stats?.coverage ?? 1).toBeLessThan(0.25);
  });

  it('testo vuoto, trascrizione vuota o troppe parole: rifiuti dedicati', () => {
    expect(alignLyrics(['', '♪'], spoken('ciao'), { wordLevel: true })).toEqual({
      ok: false,
      reason: 'empty_lyrics',
    });
    expect(alignLyrics(OFFICIAL, [], { wordLevel: true })).toEqual({
      ok: false,
      reason: 'empty_transcript',
    });
    expect(alignLyrics(OFFICIAL, [{ timeMs: 1, text: '…' }], { wordLevel: true })).toEqual({
      ok: false,
      reason: 'empty_transcript',
    });
    // Una riga sola verrebbe tagliata a 500 caratteri dal parser: servono tante righe.
    const huge = Array.from(
      { length: ALIGN_MAX_LYRICS_WORDS / 10 + 1 },
      () => 'uno due tre quattro cinque sei sette otto nove dieci',
    );
    expect(alignLyrics(huge, spoken('uno due tre'), { wordLevel: true })).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });
});
