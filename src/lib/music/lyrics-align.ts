// @polsia:user-owned — allineamento del testo UFFICIALE di un brano (fornito dall'amministratore,
// che ne ha i diritti: vale solo per i brani dichiarati con "testo": true) alle parole con tempo
// riconosciute da Solco AI. Il risultato è un Enhanced LRC con le parole GIUSTE (quelle del testo) e
// i tempi dell'audio: il karaoke del player diventa esatto anche dove il modello aveva capito male.
// Modulo puro: nessun I/O, nessun segreto, nessuna dipendenza dal server.
//
// Come funziona. Le parole del testo e quelle della trascrizione si confrontano in forma "piegata"
// (minuscole, senza accenti né punteggiatura). Un allineamento globale (Needleman-Wunsch) trova la
// corrispondenza migliore RISPETTANDO L'ORDINE: parole uguali, o quasi uguali (un refuso, una
// desinenza), si abbinano; le altre restano senza riscontro; le parole della trascrizione che il
// testo non ha si saltano. Le parole corte (articoli, congiunzioni) valgono poco, così un «e» non
// trascina l'allineamento altrove. Ogni parola abbinata prende il tempo della parola della
// trascrizione; le altre lo prendono per interpolazione fra le vicine abbinate (prima della prima
// e dopo l'ultima: un passo fisso per parola); la riga prende il tempo della sua prima parola; i
// tempi non tornano mai indietro. Se la trascrizione aveva solo i tempi delle righe (niente tag
// delle parole), anche il risultato ha solo i tempi delle righe: tempi di parola inventati non
// servono al karaoke. Un testo che trova poco riscontro (sotto ALIGN_MIN_COVERAGE delle parole)
// non si allinea: meglio dirlo che inventare i tempi di un altro brano.
import { formatLrcTimestamp, formatLrcWordTag } from '@/lib/music/lrc-format';
import {
  LYRICS_INSTRUMENTAL,
  LYRICS_MAX_LINE_CHARS,
  type ParsedLyrics,
  sanitizeLyricsLine,
} from '@/lib/music/lyrics';

/** Parole del testo al massimo (sopra: il testo non è di una canzone, o non è un solo brano). */
export const ALIGN_MAX_LYRICS_WORDS = 2000;
/** Parole della trascrizione al massimo (il confronto è righe × colonne: tenuto piccolo). */
export const ALIGN_MAX_TRANSCRIPT_WORDS = 5000;
/** Sotto questa quota di parole abbinate il testo non è (o non è ancora) quello dell'audio. */
export const ALIGN_MIN_COVERAGE = 0.25;
/** Una riga con meno di questa quota di parole abbinate è «senza riscontro»: da controllare. */
export const ALIGN_LINE_MATCH_RATIO = 0.5;
/** Passo (ms) per parola fuori dall'intervallo delle parole abbinate (prima della prima, dopo l'ultima). */
export const ALIGN_EDGE_STEP_MS = 320;
/** Dimensione massima dell'LRC prodotto (come il .lrc salvato). */
export const ALIGN_MAX_LRC_BYTES = 64 * 1024;

/** Una parola con tempo riconosciuta nell'audio (dal parser dei testi: Enhanced LRC o riga). */
export type TimedWord = { timeMs: number; text: string };

export type AlignedWord = {
  /** La parola del testo, com'è scritta nel testo. */
  text: string;
  timeMs: number;
  /** true = tempo preso da una parola riconosciuta nell'audio; false = interpolato. */
  matched: boolean;
};

export type AlignedLine = {
  text: string;
  timeMs: number;
  words: AlignedWord[];
  /** Parole della riga con un riscontro nell'audio e parole che contano (senza i segni soli). */
  matched: number;
  total: number;
};

export type AlignmentStats = {
  matchedWords: number;
  totalWords: number;
  /** matchedWords / totalWords (0 con nessuna parola). */
  coverage: number;
  /** Righe (1 = la prima riga del risultato) con poche parole abbinate: da controllare. */
  unmatchedLines: number[];
};

export type AlignmentFailure = 'empty_lyrics' | 'empty_transcript' | 'too_long' | 'no_match';

export type AlignmentResult =
  | {
      ok: true;
      lines: AlignedLine[];
      /** Enhanced LRC (tag delle parole) se la trascrizione aveva i tempi delle parole; altrimenti LRC. */
      lrc: string;
      wordTimed: boolean;
      stats: AlignmentStats;
    }
  | { ok: false; reason: AlignmentFailure; stats?: AlignmentStats };

export type AlignOptions = {
  /** true = la trascrizione aveva i tempi delle singole parole: il risultato li ha anche lui. */
  wordLevel: boolean;
  /** Durata del brano, se nota: i tempi interpolati in coda non la superano. */
  durationMs?: number | null;
};

// ─── Forma piegata e somiglianza ─────────────────────────────────────────────────────────────────

/** Minuscole, senza accenti, apostrofi e punteggiatura: la forma con cui le parole si confrontano. */
export function foldWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, '');
}

/** Distanza di Levenshtein limitata: oltre `max` torna max + 1 (senza calcolare tutto). */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [previous, current] = [current, previous];
  }
  const distance = previous[b.length] ?? max + 1;
  return distance > max ? max + 1 : distance;
}

// Punteggi interi dell'allineamento (×10): un abbinamento vale più quanto più la parola è lunga
// e sicura; un salto costa poco, così le parole in più della trascrizione non spostano il resto.
const GAP_COST = 4;

/**
 * Punteggio di abbinamento fra due parole piegate (0 = non si abbinano). Uguali: 6 (≤ 2 lettere),
 * 12 (3 lettere), 20 (da 4). Quasi uguali: un refuso da 4 lettere → 14; due da 7 lettere → 10.
 */
export function matchScore(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  if (a === b) return a.length <= 2 ? 6 : a.length === 3 ? 12 : 20;
  if (a.length < 4 || b.length < 4) return 0;
  const longest = Math.max(a.length, b.length);
  const max = longest >= 7 ? 2 : 1;
  if (a[0] !== b[0] && a[a.length - 1] !== b[b.length - 1]) return 0;
  const distance = boundedEditDistance(a, b, max);
  if (distance > max) return 0;
  return distance === 1 ? 14 : 10;
}

// ─── Testo e trascrizione in parole ─────────────────────────────────────────────────────────────

type LyricToken = { text: string; fold: string; line: number };

/** Le parole di una riga del testo (spazi come separatori), già pulite dal parser dei testi. */
export function tokenizeLyricsLine(text: string): string[] {
  return sanitizeLyricsLine(text)
    .split(' ')
    .filter((token) => token !== '');
}

/**
 * Le parole con tempo di una trascrizione (bozza di Solco AI letta dal parser dei testi): dalle
 * righe con i tag delle parole ogni parola col suo tempo; dalle righe senza tag, ogni parola col
 * tempo della riga. Le pause strumentali (♪) non contano. `wordLevel` = almeno una riga aveva i
 * tag delle parole.
 */
export function timedWordsFromLyrics(parsed: ParsedLyrics | null): {
  words: TimedWord[];
  wordLevel: boolean;
} {
  const words: TimedWord[] = [];
  let wordLevel = false;
  if (!parsed || parsed.kind !== 'synced') return { words, wordLevel };
  for (const line of parsed.lines) {
    if (line.timeMs === null || line.text === LYRICS_INSTRUMENTAL) continue;
    if (line.words && line.words.length > 0) {
      wordLevel = true;
      for (const word of line.words) {
        for (const piece of tokenizeLyricsLine(word.text)) {
          words.push({ timeMs: word.timeMs, text: piece });
        }
      }
      continue;
    }
    for (const piece of tokenizeLyricsLine(line.text)) {
      words.push({ timeMs: line.timeMs, text: piece });
    }
  }
  return { words, wordLevel };
}

// ─── Allineamento ────────────────────────────────────────────────────────────────────────────────

const DIAGONAL = 0;
const UP = 1;
const LEFT = 2;

/**
 * Needleman-Wunsch sulle forme piegate: per ogni parola del testo (riga i) l'indice della parola
 * della trascrizione abbinata, o -1. Rispetta l'ordine di entrambe le sequenze.
 */
function alignTokens(lyrics: readonly LyricToken[], transcript: readonly string[]): Int32Array {
  const n = lyrics.length;
  const m = transcript.length;
  const width = m + 1;
  const trace = new Uint8Array((n + 1) * width);
  let previous = new Int32Array(width);
  let current = new Int32Array(width);
  for (let j = 0; j <= m; j += 1) {
    previous[j] = -j * GAP_COST;
    trace[j] = LEFT;
  }
  for (let i = 1; i <= n; i += 1) {
    const fold = lyrics[i - 1]?.fold ?? '';
    current[0] = -i * GAP_COST;
    trace[i * width] = UP;
    for (let j = 1; j <= m; j += 1) {
      const up = (previous[j] ?? 0) - GAP_COST;
      const left = (current[j - 1] ?? 0) - GAP_COST;
      const score = matchScore(fold, transcript[j - 1] ?? '');
      const diagonal = score > 0 ? (previous[j - 1] ?? 0) + score : Number.NEGATIVE_INFINITY;
      if (diagonal >= up && diagonal >= left) {
        current[j] = diagonal;
        trace[i * width + j] = DIAGONAL;
      } else if (up >= left) {
        current[j] = up;
        trace[i * width + j] = UP;
      } else {
        current[j] = left;
        trace[i * width + j] = LEFT;
      }
    }
    [previous, current] = [current, previous];
  }
  const matches = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = trace[i * width + j];
    if (i > 0 && j > 0 && step === DIAGONAL) {
      matches[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && (step === UP || j === 0)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return matches;
}

/** Tempi per ogni parola del testo: abbinate dall'audio, le altre interpolate; mai all'indietro. */
function assignTimes(
  count: number,
  matchedTimes: ReadonlyArray<number | null>,
  durationMs: number | null | undefined,
): number[] {
  const times = new Array<number>(count).fill(0);
  const anchors: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (matchedTimes[index] !== null) anchors.push(index);
  }
  if (anchors.length === 0) return times;
  const first = anchors[0] ?? 0;
  const last = anchors[anchors.length - 1] ?? 0;
  const firstTime = matchedTimes[first] ?? 0;
  const lastTime = matchedTimes[last] ?? 0;
  const cap =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : Number.POSITIVE_INFINITY;
  for (let index = 0; index < first; index += 1) {
    times[index] = Math.max(0, firstTime - ALIGN_EDGE_STEP_MS * (first - index));
  }
  for (let a = 0; a < anchors.length - 1; a += 1) {
    const from = anchors[a] ?? 0;
    const to = anchors[a + 1] ?? 0;
    const fromTime = matchedTimes[from] ?? 0;
    const toTime = Math.max(fromTime, matchedTimes[to] ?? 0);
    times[from] = fromTime;
    for (let index = from + 1; index < to; index += 1) {
      times[index] = Math.round(fromTime + ((toTime - fromTime) * (index - from)) / (to - from));
    }
  }
  times[last] = lastTime;
  for (let index = last + 1; index < count; index += 1) {
    times[index] = Math.min(cap, lastTime + ALIGN_EDGE_STEP_MS * (index - last));
  }
  // Monotoni per costruzione fra le ancore; una parola abbinata con tempo più basso della
  // precedente (ordine della trascrizione rotto) non torna indietro.
  for (let index = 1; index < count; index += 1) {
    const previous = times[index - 1] ?? 0;
    if ((times[index] ?? 0) < previous) times[index] = previous;
  }
  return times;
}

/** Una riga del risultato in LRC (Enhanced se `wordLevel` e almeno due parole). */
function lrcLine(line: AlignedLine, wordLevel: boolean): string {
  const head = formatLrcTimestamp(line.timeMs / 1000);
  if (!wordLevel || line.words.length < 2) return `${head} ${line.text}`;
  const body = line.words
    .map((word) => `${formatLrcWordTag(word.timeMs / 1000)}${word.text}`)
    .join(' ');
  return `${head} ${body}`;
}

/**
 * Allinea le righe del testo ufficiale (già pulite: una riga per verso, righe vuote ammesse e
 * saltate) alle parole con tempo della trascrizione. Non fa mai throw.
 */
export function alignLyrics(
  lyricLines: readonly string[],
  transcript: readonly TimedWord[],
  options: AlignOptions,
): AlignmentResult {
  const tokens: LyricToken[] = [];
  const lineTexts: string[] = [];
  for (const raw of lyricLines) {
    const text = sanitizeLyricsLine(raw);
    if (text === '' || text === LYRICS_INSTRUMENTAL) continue;
    const line = lineTexts.length;
    lineTexts.push(text);
    for (const piece of tokenizeLyricsLine(text)) {
      tokens.push({ text: piece, fold: foldWord(piece), line });
    }
  }
  if (tokens.length === 0) return { ok: false, reason: 'empty_lyrics' };
  const spoken = transcript.filter(
    (word) => Number.isFinite(word.timeMs) && word.timeMs >= 0 && foldWord(word.text) !== '',
  );
  if (spoken.length === 0) return { ok: false, reason: 'empty_transcript' };
  if (tokens.length > ALIGN_MAX_LYRICS_WORDS || spoken.length > ALIGN_MAX_TRANSCRIPT_WORDS) {
    return { ok: false, reason: 'too_long' };
  }

  const matches = alignTokens(
    tokens,
    spoken.map((word) => foldWord(word.text)),
  );
  const matchedTimes: Array<number | null> = tokens.map((_, index) => {
    const match = matches[index] ?? -1;
    return match >= 0 ? (spoken[match]?.timeMs ?? null) : null;
  });

  const counted = tokens.filter((token) => token.fold !== '').length;
  const matchedWords = matchedTimes.filter((time) => time !== null).length;
  const coverage = counted === 0 ? 0 : matchedWords / counted;
  const perLine = lineTexts.map(() => ({ matched: 0, total: 0 }));
  for (const [index, token] of tokens.entries()) {
    const row = perLine[token.line];
    if (!row || token.fold === '') continue;
    row.total += 1;
    if (matchedTimes[index] !== null) row.matched += 1;
  }
  const unmatchedLines = perLine
    .map((row, index) =>
      row.total > 0 && row.matched / row.total < ALIGN_LINE_MATCH_RATIO ? index + 1 : 0,
    )
    .filter((line) => line > 0);
  const stats: AlignmentStats = {
    matchedWords,
    totalWords: counted,
    coverage: Math.round(coverage * 1000) / 1000,
    unmatchedLines,
  };
  if (coverage < ALIGN_MIN_COVERAGE) return { ok: false, reason: 'no_match', stats };

  const times = assignTimes(tokens.length, matchedTimes, options.durationMs);
  const lines: AlignedLine[] = lineTexts.map((text) => ({
    text,
    timeMs: 0,
    words: [],
    matched: 0,
    total: 0,
  }));
  for (const [index, token] of tokens.entries()) {
    const line = lines[token.line];
    if (!line) continue;
    line.words.push({
      text: token.text,
      timeMs: times[index] ?? 0,
      matched: matchedTimes[index] !== null,
    });
  }
  let previousTime = 0;
  for (const [index, line] of lines.entries()) {
    const row = perLine[index];
    line.matched = row?.matched ?? 0;
    line.total = row?.total ?? 0;
    const start = line.words[0]?.timeMs ?? previousTime;
    line.timeMs = Math.max(previousTime, start);
    previousTime = line.timeMs;
    // Le parole non precedono la riga.
    for (const word of line.words) if (word.timeMs < line.timeMs) word.timeMs = line.timeMs;
  }

  const wordLevel = options.wordLevel;
  let lrc = lines
    .filter((line) => line.text.length <= LYRICS_MAX_LINE_CHARS)
    .map((line) => lrcLine(line, wordLevel))
    .join('\n');
  let wordTimed = wordLevel && lines.some((line) => line.words.length >= 2);
  if (new TextEncoder().encode(lrc).length > ALIGN_MAX_LRC_BYTES && wordTimed) {
    // Con i tag delle parole non ci sta: solo i tempi delle righe.
    lrc = lines.map((line) => lrcLine(line, false)).join('\n');
    wordTimed = false;
  }
  if (new TextEncoder().encode(lrc).length > ALIGN_MAX_LRC_BYTES) {
    return { ok: false, reason: 'too_long', stats };
  }
  return { ok: true, lines, lrc, wordTimed, stats };
}
