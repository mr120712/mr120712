// @polsia:user-owned — testi dei brani (stile Spotify): parser PURO, usato dal server (brani in
// evidenza, upload degli utenti) e dal browser (file del dispositivo). Nessuna rete, nessuna
// dipendenza. Il testo arriva da file scritti da chiunque: è input NON fidato. Ogni riga perde
// caratteri di controllo, override bidi e caratteri invisibili, gli spazi si comprimono e ci sono
// tetti fissi (1 000 righe, 500 caratteri per riga) anche con input enorme o costruito apposta.
//
// Formati riconosciuti:
// - LRC sincronizzato: [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (anche più tempi sulla stessa
//   riga, "[00:12.00][00:45.10]Ritornello"), [offset:+/-ms] (positivo = il testo compare PRIMA),
//   tag di metadati ([ar:], [ti:], [al:], [length:], [by:] …) ignorati, tag parola per parola
//   "<mm:ss.xx>" (Enhanced LRC) tolti. Righe ordinate per tempo; una riga temporizzata vuota è una
//   pausa strumentale ("♪"). Con righe miste (con e senza tempo) è sincronizzato solo se la
//   maggioranza delle righe ha un tempo.
// - Testo semplice: righe così come sono (le righe vuote fra le strofe restano, una sola).
// - SYLT (testo sincronizzato ID3 letto da music-metadata): vedi lyricsFromSyncText.

/** Righe massime di un testo. */
export const LYRICS_MAX_LINES = 1000;
/** Caratteri massimi di una riga (code point). */
export const LYRICS_MAX_LINE_CHARS = 500;
/** Testo grezzo letto al massimo (caratteri): oltre si ignora, mai elaborazioni illimitate. */
export const LYRICS_MAX_INPUT_CHARS = 256 * 1024;
/** Tempo massimo plausibile di una riga: 24 ore. */
const MAX_TIME_MS = 24 * 3600 * 1000;
/** Tempi al massimo su una sola riga LRC. */
const MAX_TIMES_PER_LINE = 64;
/** Testo mostrato per una pausa strumentale (riga temporizzata vuota). */
export const LYRICS_INSTRUMENTAL = '♪';

export type LyricsKind = 'synced' | 'plain';
export type LyricsLine = { timeMs: number | null; text: string };
export type ParsedLyrics = { kind: LyricsKind; lines: LyricsLine[] };

function isStrippedCodePoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x200b ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

function isSpaceCodePoint(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0b ||
    cp === 0x0c ||
    cp === 0x20 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/**
 * Una riga sicura da mostrare: niente caratteri di controllo, override/isolati bidi, BOM,
 * surrogati isolati o invisibili; spazi compressi; al massimo LYRICS_MAX_LINE_CHARS caratteri.
 */
export function sanitizeLyricsLine(value: string): string {
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const char of value) {
    if (count >= LYRICS_MAX_LINE_CHARS) break;
    const cp = char.codePointAt(0) ?? 0;
    if (isSpaceCodePoint(cp)) {
      pendingSpace = count > 0;
      continue;
    }
    if (isStrippedCodePoint(cp)) continue;
    if (pendingSpace) {
      out += ' ';
      count += 1;
      pendingSpace = false;
      if (count >= LYRICS_MAX_LINE_CHARS) break;
    }
    out += char;
    count += 1;
  }
  return out;
}

/** Testo grezzo → righe: niente BOM, a capo uniformi, mai oltre LYRICS_MAX_INPUT_CHARS. */
function rawLines(text: string): string[] {
  const capped =
    text.length > LYRICS_MAX_INPUT_CHARS ? text.slice(0, LYRICS_MAX_INPUT_CHARS) : text;
  return capped.replace(/^\uFEFF/, '').split(/\r\n|\r|\n|\u2028|\u2029/);
}

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (minuti fino a 5 cifre, secondi da 1 o 2 cifre: un
// tempo fuori scala, oltre le 24 ore, si riconosce come tempo e si scarta). Nessuna ripetizione
// annidata: tempo lineare anche su righe lunghissime.
const TIME_TAG = /^\[(\d{1,5}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
// [chiave:valore] dei metadati LRC ([ar:], [ti:], [length:], [offset:] …): la chiave è alfabetica.
const META_TAG = /^\[([A-Za-z#][A-Za-z0-9_ -]{0,31}):([^\]\n]{0,512})\]\s*$/;
// Tag parola per parola dell'Enhanced LRC: <mm:ss.xx>.
const WORD_TAG = /<\d{1,5}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function tagTimeMs(match: RegExpExecArray): number | null {
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) return null;
  const fraction = match[3] ?? '';
  // 1 cifra = decimi, 2 = centesimi, 3 = millesimi.
  const ms = fraction === '' ? 0 : Number(fraction.padEnd(3, '0'));
  const total = (minutes * 60 + seconds) * 1000 + ms;
  return total <= MAX_TIME_MS ? total : null;
}

/** Tempi in testa alla riga e il testo che resta, o null se la riga non inizia con un tempo. */
function leadingTimes(line: string): { times: number[]; rest: string } | null {
  let rest = line.trimStart();
  const times: number[] = [];
  let matched = false;
  for (let n = 0; n < MAX_TIMES_PER_LINE * 4; n += 1) {
    const match = TIME_TAG.exec(rest);
    if (!match) break;
    matched = true;
    const time = tagTimeMs(match);
    if (time !== null && times.length < MAX_TIMES_PER_LINE) times.push(time);
    rest = rest.slice(match[0].length).trimStart();
  }
  return matched ? { times, rest } : null;
}

function parseOffset(value: string): number {
  const match = /^\s*([+-]?)(\d{1,7})\s*$/.exec(value);
  if (!match) return 0;
  const amount = Number(match[2]);
  return match[1] === '-' ? -amount : amount;
}

/** Riga di testo pulita (tag parola per parola tolti), '' se vuota. */
function cleanText(value: string): string {
  return sanitizeLyricsLine(value.replace(WORD_TAG, ''));
}

/** Righe vuote multiple → una sola; niente righe vuote in testa o in coda. */
function tidyPlain(lines: string[]): LyricsLine[] {
  const out: LyricsLine[] = [];
  for (const text of lines) {
    if (out.length >= LYRICS_MAX_LINES) break;
    if (text === '') {
      if (out.length === 0 || out[out.length - 1]?.text === '') continue;
    }
    out.push({ timeMs: null, text });
  }
  while (out.length > 0 && out[out.length - 1]?.text === '') out.pop();
  return out;
}

/** Righe sincronizzate: ordinate per tempo (stabile), pause strumentali consecutive unite. */
function tidySynced(entries: { timeMs: number; text: string; order: number }[]): LyricsLine[] {
  const sorted = [...entries].sort((a, b) => a.timeMs - b.timeMs || a.order - b.order);
  const out: LyricsLine[] = [];
  for (const entry of sorted) {
    if (out.length >= LYRICS_MAX_LINES) break;
    const text = entry.text === '' ? LYRICS_INSTRUMENTAL : entry.text;
    const previous = out[out.length - 1];
    // Due pause di fila (o una pause in testa a 0:00 seguita da un'altra) non aggiungono nulla.
    if (text === LYRICS_INSTRUMENTAL && previous?.text === LYRICS_INSTRUMENTAL) continue;
    out.push({ timeMs: entry.timeMs, text });
  }
  // Una pausa finale dopo l'ultima riga cantata resta (indica la coda strumentale).
  return out.some((line) => line.text !== LYRICS_INSTRUMENTAL) ? out : [];
}

/**
 * Testo (LRC o semplice) → righe da mostrare, o null se non resta nulla di leggibile. Mai
 * un'eccezione, qualunque sia l'input.
 */
export function parseLyrics(text: string | null | undefined): ParsedLyrics | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return parseLyricsUnchecked(text);
  } catch {
    return null;
  }
}

function parseLyricsUnchecked(text: string): ParsedLyrics | null {
  let offsetMs = 0;
  const timed: { times: number[]; text: string }[] = [];
  // Tutte le righe "di contenuto" nell'ordine del file (con o senza tempo), per il testo semplice.
  const plain: string[] = [];
  let timedContent = 0;
  let untimedContent = 0;

  for (const raw of rawLines(text)) {
    const line = raw.trim();
    const meta = META_TAG.exec(line);
    if (meta && !TIME_TAG.test(line)) {
      if ((meta[1] ?? '').toLowerCase() === 'offset') offsetMs = parseOffset(meta[2] ?? '');
      continue;
    }
    const times = leadingTimes(line);
    if (times) {
      const content = cleanText(times.rest);
      if (times.times.length > 0) {
        timed.push({ times: times.times, text: content });
        timedContent += 1;
      }
      plain.push(content);
      continue;
    }
    const content = cleanText(line);
    if (content !== '') untimedContent += 1;
    plain.push(content);
  }

  // Sincronizzato solo se la maggioranza delle righe ha un tempo (le altre si scartano).
  if (timedContent > 0 && timedContent > untimedContent) {
    const entries: { timeMs: number; text: string; order: number }[] = [];
    let order = 0;
    for (const row of timed) {
      for (const time of row.times) {
        if (entries.length >= LYRICS_MAX_LINES * 2) break;
        entries.push({
          timeMs: Math.min(MAX_TIME_MS, Math.max(0, time - offsetMs)),
          text: row.text,
          order,
        });
        order += 1;
      }
    }
    const lines = tidySynced(entries);
    if (lines.length > 0) return { kind: 'synced', lines };
  }

  const lines = tidyPlain(plain);
  return lines.some((line) => line.text !== '') ? { kind: 'plain', lines } : null;
}

/** Un frammento di SYLT come lo restituisce music-metadata (timestamp in millisecondi). */
export type SyncTextEntry = { text?: string | null; timestamp?: number | null };

/**
 * Testo sincronizzato SYLT (ID3) → righe. Gli autori lo scrivono in due modi: una voce per riga,
 * oppure sillabe con l'a capo ("\n", "\r\n") all'inizio della voce che apre una riga nuova o alla
 * fine di quella che la chiude; una voce di soli a capo chiude la riga corrente. `null` se non
 * resta nulla. I tempi devono essere già in millisecondi (formato 2 del frame).
 */
export function lyricsFromSyncText(
  entries: readonly SyncTextEntry[] | null | undefined,
): ParsedLyrics | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  try {
    const capped = entries.slice(0, LYRICS_MAX_LINES * 8);
    const byLines = capped.some((entry) => /[\r\n]/.test(entry?.text ?? ''));
    const rows: { timeMs: number; text: string; order: number }[] = [];
    let current: { timeMs: number; text: string; order: number } | null = null;
    // La voce precedente finiva con un a capo: la prossima apre una riga nuova.
    let previousEnded = false;
    for (const [order, entry] of capped.entries()) {
      const time = Number(entry?.timestamp);
      const raw = typeof entry?.text === 'string' ? entry.text : '';
      if (!Number.isFinite(time) || time < 0 || time > MAX_TIME_MS) continue;
      if (!byLines) {
        rows.push({ timeMs: Math.round(time), text: cleanText(raw), order });
        continue;
      }
      // Voce di soli a capo: chiude la riga corrente senza aprirne una vuota.
      if (/[\r\n]/.test(raw) && raw.trim() === '') {
        if (current) rows.push({ ...current, text: cleanText(current.text) });
        current = null;
        previousEnded = false;
        continue;
      }
      // Con gli a capo: una voce che inizia con "\n" (o la prima, o quella dopo una voce che
      // finiva con "\n") apre una riga; le altre si attaccano alla riga corrente (sillabe).
      const startsLine = current === null || previousEnded || /^[\r\n]/.test(raw);
      previousEnded = /[\r\n]$/.test(raw);
      const piece = raw.replace(/[\r\n]+/g, ' ');
      if (startsLine) {
        if (current) rows.push({ ...current, text: cleanText(current.text) });
        current = { timeMs: Math.round(time), text: piece, order };
      } else if (current && current.text.length < LYRICS_MAX_LINE_CHARS * 2) {
        current.text += piece;
      }
    }
    if (current) rows.push({ ...current, text: cleanText(current.text) });
    const lines = tidySynced(rows);
    return lines.length > 0 ? { kind: 'synced', lines } : null;
  } catch {
    return null;
  }
}

/**
 * Normalizza il testo che un utente incolla (upload in /pubblica): niente BOM o caratteri di
 * controllo (tranne a capo e tab), niente override bidi, spazi in coda tolti, al massimo una riga
 * vuota fra le strofe, testo tagliato ai bordi. È il testo SALVATO (LRC o semplice).
 */
export function normalizeLyricsInput(text: string): string {
  const lines = rawLines(text).map((line) => {
    let out = '';
    for (const char of line) {
      const cp = char.codePointAt(0) ?? 0;
      if (cp === 0x09) {
        out += ' ';
        continue;
      }
      if (isStrippedCodePoint(cp)) continue;
      out += char;
    }
    return out.trimEnd();
  });
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Indice della riga attiva a `timeMs` in righe sincronizzate (ordinate): l'ultima con tempo ≤ ora,
 * -1 prima della prima riga. Ricerca binaria: va bene anche chiamata spesso.
 */
export function activeLyricsLine(lines: readonly LyricsLine[], timeMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const time = lines[middle]?.timeMs;
    if (time !== null && time !== undefined && time <= timeMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
