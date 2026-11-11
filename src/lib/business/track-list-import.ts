// @polsia:user-owned — legge un elenco di brani portato dall'utente: righe "Artista - Titolo"
// oppure un file CSV esportato da un altro servizio (Exportify, TuneMyMusic, Soundiiz…).
// Solco non usa API di terzi: i dati li fornisce l'utente. Funzioni pure, testabili.

export const TRACK_LIST_MAX_TRACKS = 200;
const MAX_FIELD = 200;

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
  skipped: number;
};

function clean(value: string | undefined | null) {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

/** Lowercase, no accents, no punctuation: two spellings of the same song collapse. */
export function songIdentity(title: string, artist: string | null) {
  const norm = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(artist ?? '')}|${norm(title)}`;
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter: string) {
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
    if (char === '"' && field === '') quoted = true;
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

function spotifyTrackUrl(value: string) {
  const raw = value.trim();
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(raw)?.[1];
  if (uri) return `https://open.spotify.com/track/${uri}`;
  const url = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/.exec(
    raw,
  )?.[1];
  return url ? `https://open.spotify.com/track/${url}` : null;
}

function durationFrom(value: string, header: string) {
  const raw = value.trim();
  if (!raw) return null;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) {
    const seconds = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
    return seconds > 0 ? seconds : null;
  }
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return null;
  const inMs = header.includes('ms') || number > 10_000;
  const seconds = Math.round(inMs ? number / 1000 : number);
  return seconds > 0 && seconds < 24 * 3600 ? seconds : null;
}

function detectDelimiter(firstLine: string) {
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const best = counts.sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}

function fromCsv(text: string): TrackListResult | null {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const delimiter = detectDelimiter(firstLine);
  if (!delimiter) return null;
  const rows = parseCsv(text, delimiter);
  const header = rows[0];
  if (!header) return null;
  const titleAt = columnIndex(header, TITLE_COLUMNS);
  const artistAt = columnIndex(header, ARTIST_COLUMNS);
  if (titleAt < 0 || artistAt < 0) return null;
  const durationAt = columnIndex(header, DURATION_COLUMNS);
  const urlAt = columnIndex(header, URL_COLUMNS);
  const durationHeader = durationAt >= 0 ? (header[durationAt] ?? '').toLowerCase() : '';
  const tracks: ImportedTrack[] = [];
  let skipped = 0;
  for (const cells of rows.slice(1)) {
    const title = clean(cells[titleAt]);
    if (!title) {
      skipped += 1;
      continue;
    }
    // Exportify separates several artists with commas or semicolons inside one cell.
    const artist = clean(
      (cells[artistAt] ?? '')
        .split(/\s*[;,]\s*/)
        .filter(Boolean)
        .join(', '),
    );
    tracks.push({
      title,
      artist: artist || null,
      durationSeconds:
        durationAt >= 0 ? durationFrom(cells[durationAt] ?? '', durationHeader) : null,
      sourceUrl: urlAt >= 0 ? spotifyTrackUrl(cells[urlAt] ?? '') : null,
    });
  }
  return { format: 'csv', tracks, skipped };
}

const NUMBERING = /^\s*(?:\d{1,4}\s*[.)\-:]\s*|\d{1,4}\s+|[-*•·]\s+)/;
const SEPARATORS = /\s+[-–—]\s+|\t/;

function fromLines(text: string): TrackListResult {
  const tracks: ImportedTrack[] = [];
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(NUMBERING, '').trim();
    if (!line) continue;
    const url = spotifyTrackUrl(line);
    if (url || /^https?:\/\//i.test(line)) {
      // A bare link carries no title or artist: nothing to search for.
      skipped += 1;
      continue;
    }
    const parts = line.split(SEPARATORS);
    const [first, ...rest] = parts;
    const artist = rest.length > 0 ? clean(first) : '';
    const title = clean(rest.length > 0 ? rest.join(' - ') : first);
    if (!title) {
      skipped += 1;
      continue;
    }
    tracks.push({ title, artist: artist || null, durationSeconds: null, sourceUrl: null });
  }
  return { format: 'lines', tracks, skipped };
}

/** Reads a pasted list or a CSV export; drops duplicates and caps the list. */
export function parseTrackList(text: string): TrackListResult {
  const input = text.replace(/^﻿/, '');
  const parsed = fromCsv(input) ?? fromLines(input);
  const seen = new Set<string>();
  const unique: ImportedTrack[] = [];
  let skipped = parsed.skipped;
  for (const track of parsed.tracks) {
    const id = songIdentity(track.title, track.artist);
    if (seen.has(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    if (unique.length >= TRACK_LIST_MAX_TRACKS) {
      skipped += 1;
      continue;
    }
    unique.push(track);
  }
  return { format: parsed.format, tracks: unique, skipped };
}
