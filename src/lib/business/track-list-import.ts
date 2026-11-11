// @polsia:user-owned — legge un elenco di brani portato dall'utente: righe "Artista - Titolo"
// oppure un file CSV esportato da un altro servizio (Exportify, TuneMyMusic, Soundiiz…).
// Solco non usa API di terzi: i dati li fornisce l'utente. Funzioni pure, testabili.
// Ogni espressione regolare lavora su testo già accorciato e senza spazi ripetuti, così un
// input costruito apposta non può rallentare il server (niente backtracking quadratico).

export const TRACK_LIST_MAX_TRACKS = 200;
const MAX_FIELD = 200;
/** Longest line or CSV cell looked at; anything beyond is not a song title. */
const MAX_LINE = 1_000;

export type ImportedTrack = {
  title: string;
  artist: string | null;
  durationSeconds: number | null;
  /** Link al brano sul servizio di origine (solo open.spotify.com/track/…), se presente. */
  sourceUrl: string | null;
};

export type TrackListResult = {
  format: 'csv' | 'lines';
  tracks: ImportedTrack[];
  /** Righe vuote o illeggibili e doppioni. */
  skipped: number;
  /** Brani validi oltre il limite di TRACK_LIST_MAX_TRACKS. */
  truncated: number;
  /** A table without a recognisable title column: the caller explains the expected columns. */
  error?: 'missing_columns';
};

/**
 * Drops control characters (except tab and newlines) and lone UTF-16 surrogates, which break
 * the database. Iterating by code point keeps valid surrogate pairs (emoji) together.
 */
function stripControl(value: string) {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    const loneSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (!control && !loneSurrogate) out += char;
  }
  return out;
}

function clean(value: string | undefined | null) {
  return stripControl((value ?? '').slice(0, MAX_LINE))
    .slice(0, MAX_LINE)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD);
}

function normalizeName(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Same song, different spelling (case, accents, punctuation) → same identity. Unicode-aware:
 * Cyrillic, CJK, Greek, Arabic… titles stay distinct. A title with no letters or digits keeps
 * its raw text, so two such titles are never merged.
 */
export function songIdentity(title: string, artist: string | null) {
  const normalizedTitle = normalizeName(title) || title.trim().toLowerCase();
  return `${normalizeName(artist ?? '')}|${normalizedTitle}`;
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter: string, quotes = true): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (quotes && char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  // An opening quote that never closes would swallow the rest of the file: read it again
  // treating quotes as plain characters.
  if (quoted) return parseCsv(text, delimiter, false);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

const TITLE_COLUMNS = [
  'track name',
  'track title',
  'song name',
  'title',
  'titolo',
  'track',
  'song',
  'brano',
  'name',
  'nome',
];
const ARTIST_COLUMNS = [
  'artist name(s)',
  'artist names',
  'artist name',
  'artists',
  'artist',
  'artista',
  'artisti',
];
const DURATION_COLUMNS = ['duration (ms)', 'duration_ms', 'duration', 'durata'];
const URL_COLUMNS = [
  'track uri',
  'spotify uri',
  'spotify - id',
  'uri',
  'url',
  'link',
  'spotify url',
];

function columnIndex(header: string[], names: string[]) {
  const lower = header.map((cell) => cell.trim().toLowerCase());
  for (const name of names) {
    const index = lower.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function spotifyTrackUrl(value: string, header = '') {
  const raw = value.trim().slice(0, 200);
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(raw)?.[1];
  if (uri) return `https://open.spotify.com/track/${uri}`;
  const url = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/.exec(
    raw,
  )?.[1];
  if (url) return `https://open.spotify.com/track/${url}`;
  // Exportify-style "Spotify - id" columns hold the bare 22-character id.
  if (header.includes('spotify') && /^[A-Za-z0-9]{22}$/.test(raw)) {
    return `https://open.spotify.com/track/${raw}`;
  }
  return null;
}

const MAX_DURATION = 24 * 3600 - 1;

function durationFrom(value: string, header: string) {
  const raw = value.trim().slice(0, 20);
  if (!raw) return null;
  const clock = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(raw);
  if (clock) {
    const secondsPart = Number(clock[3]);
    if (secondsPart >= 60) return null;
    const seconds = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + secondsPart;
    return seconds > 0 && seconds <= MAX_DURATION ? seconds : null;
  }
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return null;
  const inMs = header.includes('ms') || number > 10_000;
  const seconds = Math.round(inMs ? number / 1000 : number);
  return seconds > 0 && seconds <= MAX_DURATION ? seconds : null;
}

function firstLineOf(text: string) {
  return text.split(/\r\n|\r|\n/, 50).find((line) => line.trim() !== '') ?? '';
}

function detectDelimiter(firstLine: string) {
  const line = firstLine.slice(0, MAX_LINE);
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1] as const);
  const best = counts.sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

/** A real table: 2+ columns and most rows with the same number of cells as the header. */
function looksLikeTable(rows: string[][]) {
  const width = rows[0]?.length ?? 0;
  if (width < 2 || rows.length < 2) return false;
  const sameWidth = rows.slice(1).filter((cells) => cells.length === width).length;
  return sameWidth >= Math.ceil((rows.length - 1) * 0.8);
}

function fromCsv(text: string): TrackListResult | null {
  const delimiter = detectDelimiter(firstLineOf(text));
  if (!delimiter) return null;
  const rows = parseCsv(text, delimiter);
  const header = rows[0];
  if (!header) return null;
  const titleAt = columnIndex(header, TITLE_COLUMNS);
  if (titleAt < 0) {
    return looksLikeTable(rows)
      ? { format: 'csv', tracks: [], skipped: 0, truncated: 0, error: 'missing_columns' }
      : null;
  }
  const artistAt = columnIndex(header, ARTIST_COLUMNS);
  const durationAt = columnIndex(header, DURATION_COLUMNS);
  const urlAt = columnIndex(header, URL_COLUMNS);
  const durationHeader = durationAt >= 0 ? (header[durationAt] ?? '').toLowerCase() : '';
  const urlHeader = urlAt >= 0 ? (header[urlAt] ?? '').toLowerCase() : '';
  const tracks: ImportedTrack[] = [];
  let skipped = 0;
  for (const cells of rows.slice(1)) {
    const title = clean(cells[titleAt]);
    if (!title) {
      skipped += 1;
      continue;
    }
    // Exportify separates several artists with commas or semicolons inside one cell. The cell
    // is cleaned (shortened, single spaces) before splitting.
    const artistCell = artistAt >= 0 ? clean(cells[artistAt]) : '';
    const artist = artistCell
      .split(/ ?[;,] ?/)
      .filter(Boolean)
      .join(', ')
      .slice(0, MAX_FIELD);
    tracks.push({
      title,
      artist: artist || null,
      durationSeconds:
        durationAt >= 0 ? durationFrom(cells[durationAt] ?? '', durationHeader) : null,
      sourceUrl: urlAt >= 0 ? spotifyTrackUrl(cells[urlAt] ?? '', urlHeader) : null,
    });
  }
  return { format: 'csv', tracks, skipped, truncated: 0 };
}

const LIST_MARKER = /^(\d{1,4})[.)] +/;
const BARE_NUMBER = /^(\d{1,4}) +/;
const BULLET = /^[-*•·] +/;
const SEPARATOR = / [-–—] |\t/;

function fromLines(text: string): TrackListResult {
  const tracks: ImportedTrack[] = [];
  let skipped = 0;
  let position = 0;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    // Shorten and collapse spaces first: every pattern below then runs in linear time.
    let line = stripControl(rawLine.slice(0, MAX_LINE))
      .replace(/[^\S\t]+/g, ' ')
      .trim();
    if (!line) continue;
    position += 1;
    // "1. Song" / "2) Song" are list numbering; a bare "3 Song" only when 3 is the position,
    // so artists that start with digits ("50 Cent", "883") keep their name.
    const marker = LIST_MARKER.exec(line);
    const bare = BARE_NUMBER.exec(line);
    if (marker) line = line.slice(marker[0].length);
    else if (bare && Number(bare[1]) === position) line = line.slice(bare[0].length);
    else line = line.replace(BULLET, '');
    line = line.trim();
    if (!line) continue;
    if (spotifyTrackUrl(line) || /^https?:\/\//i.test(line)) {
      // A bare link carries no title or artist: nothing to search for.
      skipped += 1;
      continue;
    }
    const parts = line.split(SEPARATOR);
    const [first, ...rest] = parts;
    const artist = rest.length > 0 ? clean(first) : '';
    const title = clean(rest.length > 0 ? rest.join(' - ') : first);
    if (!title) {
      skipped += 1;
      continue;
    }
    tracks.push({ title, artist: artist || null, durationSeconds: null, sourceUrl: null });
  }
  return { format: 'lines', tracks, skipped, truncated: 0 };
}

/** Reads a pasted list or a CSV export; drops duplicates and caps the list. */
export function parseTrackList(text: string): TrackListResult {
  const input = text.replace(/^﻿/, '');
  const parsed = fromCsv(input) ?? fromLines(input);
  if (parsed.error) return parsed;
  const seen = new Set<string>();
  const unique: ImportedTrack[] = [];
  let skipped = parsed.skipped;
  let truncated = 0;
  for (const track of parsed.tracks) {
    const id = songIdentity(track.title, track.artist);
    if (seen.has(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    if (unique.length >= TRACK_LIST_MAX_TRACKS) {
      truncated += 1;
      continue;
    }
    unique.push(track);
  }
  return { format: parsed.format, tracks: unique, skipped, truncated };
}
