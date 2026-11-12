// @polsia:user-owned — parser dei trascritti dei podcast (tag <podcast:transcript> del Podcasting
// 2.0). Supporta WebVTT, SubRip (SRT), il JSON di Podcasting 2.0 e il testo semplice/HTML. Funzione
// PURA (nessuna rete): chi la chiama fornisce il testo già scaricato. Produce una lista di "cue"
// con, dove disponibile, il tempo di inizio in secondi (per sincronizzare con la riproduzione).

export type TranscriptCue = {
  /** Secondi di inizio del segmento, o null se il formato non è temporizzato. */
  startSeconds: number | null;
  text: string;
};

export type ParsedTranscript = {
  /** true se almeno un cue ha un tempo (si può sincronizzare e saltare a un punto). */
  timed: boolean;
  cues: TranscriptCue[];
};

const MAX_CUES = 6000;
const MAX_TEXT = 2_000;

function clean(text: string): string {
  return (
    text
      // Tag VTT/HTML inline (<v Speaker>, <c>, <b>, <i>, <00:00:01.000> …).
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT)
  );
}

/** "HH:MM:SS.mmm" / "MM:SS.mmm" / con virgola (SRT) → secondi. null se non è un tempo. */
function parseTimestamp(value: string): number | null {
  const match = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] ?? '0').padEnd(3, '0'));
  if (![hours, minutes, seconds, millis].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/** Blocchi separati da righe vuote (VTT/SRT): riga di timing "start --> end" + testo. */
function parseCueBlocks(text: string): ParsedTranscript {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^WEBVTT[^\n]*\n/i, '');
  const blocks = normalized.split(/\n\s*\n/);
  const cues: TranscriptCue[] = [];
  for (const block of blocks) {
    if (cues.length >= MAX_CUES) break;
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    const timingLine = timingIndex >= 0 ? lines[timingIndex] : undefined;
    if (!timingLine) continue;
    const start = parseTimestamp(timingLine.split('-->')[0] ?? '');
    const body = clean(lines.slice(timingIndex + 1).join(' '));
    if (body) cues.push({ startSeconds: start, text: body });
  }
  return { timed: cues.some((cue) => cue.startSeconds !== null), cues };
}

/** JSON di Podcasting 2.0: { segments: [{ startTime, body }] }. */
function parseJson(text: string): ParsedTranscript | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const segments =
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { segments?: unknown }).segments)
      ? (data as { segments: unknown[] }).segments
      : null;
  if (!segments) return null;
  const cues: TranscriptCue[] = [];
  for (const raw of segments) {
    if (cues.length >= MAX_CUES) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const seg = raw as { startTime?: unknown; body?: unknown; text?: unknown; speaker?: unknown };
    const body =
      typeof seg.body === 'string' ? seg.body : typeof seg.text === 'string' ? seg.text : '';
    const cleaned = clean(body);
    if (!cleaned) continue;
    const start =
      typeof seg.startTime === 'number' && Number.isFinite(seg.startTime) ? seg.startTime : null;
    cues.push({ startSeconds: start, text: cleaned });
  }
  return { timed: cues.some((cue) => cue.startSeconds !== null), cues };
}

/** Testo semplice / HTML: paragrafi senza tempo. */
function parsePlain(text: string, html: boolean): ParsedTranscript {
  const source = html ? text.replace(/<\/(p|div|br)[^>]*>/gi, '\n') : text;
  const cues: TranscriptCue[] = [];
  for (const part of source.split(/\n\s*\n|\n/)) {
    if (cues.length >= MAX_CUES) break;
    const body = clean(part);
    if (body) cues.push({ startSeconds: null, text: body });
  }
  return { timed: false, cues };
}

/** Converte un trascritto grezzo (dato il suo MIME) in cue. Riconosce anche il formato dal contenuto. */
export function parseTranscript(raw: string, type: string): ParsedTranscript {
  const text = raw.replace(/^﻿/, '');
  const mime = (type || '').toLowerCase();

  if (mime.includes('json') || /^\s*[{[]/.test(text)) {
    const json = parseJson(text);
    if (json && json.cues.length > 0) return json;
  }
  if (
    mime.includes('vtt') ||
    mime.includes('srt') ||
    mime.includes('subrip') ||
    /^\s*WEBVTT/i.test(text) ||
    text.includes('-->')
  ) {
    const blocks = parseCueBlocks(text);
    if (blocks.cues.length > 0) return blocks;
  }
  return parsePlain(text, mime.includes('html') || /<\w+[^>]*>/.test(text));
}
