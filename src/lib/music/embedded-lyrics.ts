// @polsia:user-owned — testo INCORPORATO in un file audio, dai metadati letti con music-metadata
// (lato server, per i brani in evidenza dichiarati con "testo": true). Modulo puro: riceve il
// risultato già letto e sceglie il testo migliore. Fonti riconosciute: ID3 USLT/ULT (testo) e
// SYLT (sincronizzato), Vorbis/FLAC LYRICS e UNSYNCEDLYRICS, MP4 ©lyr, APE "Lyrics", ASF
// "WM/Lyrics". Un testo sincronizzato vince su uno semplice. Come riserva, solo se non c'è nessuno
// di questi, i frame ID3 TXXX con descrizione USLT/LYRICS/UNSYNCEDLYRICS: è lì che ffmpeg (e i
// programmi basati su ffmpeg) scrive il testo negli MP3, anche convertendo un FLAC. Mai
// un'eccezione.
import type { IAudioMetadata } from 'music-metadata';
import { lyricsFromSyncText, type ParsedLyrics, parseLyrics } from '@/lib/music/lyrics';

/** Formato dei tempi SYLT in millisecondi (gli altri, in frame MPEG, non sono convertibili). */
const SYLT_MILLISECONDS = 2;
/** Tag nativi testuali con il testo del brano (confronto senza maiuscole). */
const TEXT_LYRICS_TAGS = new Set([
  'uslt',
  'ult',
  'lyrics',
  'unsyncedlyrics',
  'unsynced lyrics',
  '©lyr',
  'wm/lyrics',
]);
/** Frame ID3 TXXX con il testo (scritti da ffmpeg): usati solo se mancano USLT/SYLT & co. */
const TXXX_LYRICS_TAGS = new Set([
  'txxx:uslt',
  'txxx:lyrics',
  'txxx:unsyncedlyrics',
  'txxx:unsynced lyrics',
]);
/** Tag nativi esaminati al massimo (un file vero ne ha poche decine). */
const MAX_NATIVE_TAGS = 2000;

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
};

/** Tipo audio di un brano dall'estensione (indizio per music-metadata), o null. */
export function audioMimeForPathname(pathname: string): string | null {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return Object.hasOwn(AUDIO_MIME_BY_EXTENSION, extension)
    ? (AUDIO_MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

type SyncLike = {
  syncText?: unknown;
  timeStampFormat?: unknown;
  text?: unknown;
};

function asRecord(value: unknown): SyncLike | null {
  return typeof value === 'object' && value !== null ? (value as SyncLike) : null;
}

/** Testo da un valore SYLT: sincronizzato se in millisecondi, altrimenti semplice. */
function fromSyncValue(value: SyncLike): ParsedLyrics | null {
  const entries = Array.isArray(value.syncText) ? value.syncText : [];
  if (entries.length > 0 && value.timeStampFormat === SYLT_MILLISECONDS) {
    const synced = lyricsFromSyncText(entries);
    if (synced) return synced;
  }
  if (entries.length > 0) {
    const joined = entries
      .map((entry) => {
        const text = asRecord(entry)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
    return parseLyrics(joined);
  }
  return typeof value.text === 'string' ? parseLyrics(value.text) : null;
}

/** Testo da un valore testuale (stringa, o oggetto { text } come USLT). */
function fromTextValue(value: unknown): ParsedLyrics | null {
  if (typeof value === 'string') return parseLyrics(value);
  const record = asRecord(value);
  if (record && typeof record.text === 'string') return parseLyrics(record.text);
  return null;
}

/** Il primo testo sincronizzato fra i candidati, altrimenti il primo semplice, o null. */
function best(candidates: (ParsedLyrics | null)[]): ParsedLyrics | null {
  const found = candidates.filter((item): item is ParsedLyrics => item !== null);
  return found.find((item) => item.kind === 'synced') ?? found[0] ?? null;
}

/**
 * Il testo incorporato nei metadati letti da music-metadata, o null. Preferisce un testo
 * sincronizzato (SYLT in millisecondi, oppure LRC scritto in un tag di testo).
 */
export function lyricsFromMetadata(
  metadata: Pick<IAudioMetadata, 'native' | 'common'> | null,
): ParsedLyrics | null {
  if (!metadata) return null;
  try {
    const candidates: (ParsedLyrics | null)[] = [];
    const fallbacks: (ParsedLyrics | null)[] = [];
    let seen = 0;
    for (const tags of Object.values(metadata.native ?? {})) {
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        seen += 1;
        if (seen > MAX_NATIVE_TAGS) break;
        const id = typeof tag?.id === 'string' ? tag.id.toLowerCase() : '';
        if (id === 'sylt' || id === 'slt') {
          const value = asRecord(tag.value);
          if (value) candidates.push(fromSyncValue(value));
        } else if (TEXT_LYRICS_TAGS.has(id)) {
          candidates.push(fromTextValue(tag.value));
        } else if (TXXX_LYRICS_TAGS.has(id)) {
          fallbacks.push(fromTextValue(tag.value));
        }
      }
    }
    const fromNative = best(candidates) ?? best(fallbacks);
    if (fromNative) return fromNative;
    // Formati che non conosciamo per nome: il campo comune di music-metadata.
    const common = Array.isArray(metadata.common?.lyrics) ? metadata.common.lyrics : [];
    return best(
      common.slice(0, 16).map((item) => {
        const value = asRecord(item);
        return value ? fromSyncValue(value) : null;
      }),
    );
  } catch {
    return null;
  }
}
