// @polsia:user-owned — TESTO incorporato nei file audio del dispositivo ("La tua musica"). Si legge
// nel browser, dal Blob salvato in IndexedDB, solo quando l'ascoltatore apre il pannello "Testo":
// nessuna rete, il testo non lascia mai il dispositivo (fonte 'local', credito "Dal tuo file").
// Solo i file dell'ascoltatore (fonte 'local'): mai i brani scaricati da Audius o dai podcast, e
// mai la copia offline di un "brano in evidenza" (fonte 'featured-download', letta dal record sul
// dispositivo: vale anche senza il registro delle copie in localStorage). Il testo di un brano in
// evidenza si mostra solo dal server, se diritti.json dichiara "testo": true per quel file.
//
// Formati: ID3v2 USLT/SYLT (v2.3/2.4) e ULT/SLT (v2.2) negli MP3 (come riserva i TXXX "USLT" o
// "LYRICS" scritti da ffmpeg), '©lyr' negli M4A/MP4, commenti
// Vorbis LYRICS/UNSYNCEDLYRICS nei FLAC. Lettura a pezzi come per i tag (tags.ts): mai l'audio,
// mai più di MAX_TAG_BYTES per blocco. Input non fidato: lunghezze controllate, nessuna eccezione.
// Ogg Vorbis/Opus non sono letti (i commenti stanno nelle pagine Ogg, da ricomporre).
//
// Caricato con import() dal pannello del testo: non entra nel bundle di ogni pagina.

import { LYRICS_CREDIT_LOCAL, type Lyrics } from '@/lib/contracts/lyrics';
import { afterTerminator, readId3v2Header, walkId3v2Frames } from '@/lib/local-music/id3';
import { looksLikeMp4, readMp4LyricsText } from '@/lib/local-music/mp4';
import { getLocalMusicReader, type LocalMusicReader } from '@/lib/local-music/reader';
import {
  type ByteReader,
  byteAt,
  decodeLatin1,
  decodeUtf8,
  decodeUtf16,
  decodeUtf16WithBom,
  MAX_TAG_BYTES,
  readUint32,
} from '@/lib/local-music/tag-utils';
import { blobByteReader } from '@/lib/local-music/tags';
import { localTrackSource } from '@/lib/local-music/types';
import {
  lyricsFromSyncText,
  type ParsedLyrics,
  parseLyrics,
  type SyncTextEntry,
} from '@/lib/music/lyrics';

/** Byte massimi decodificati per un testo (bastano per testi lunghissimi in ogni codifica). */
const MAX_LYRICS_BYTES = 512 * 1024;
/** Voci SYLT lette al massimo. */
const MAX_SYLT_ENTRIES = 8000;
/** Blocchi di metadati FLAC esaminati al massimo. */
const MAX_FLAC_BLOCKS = 64;
const NUL = String.fromCharCode(0);

function withoutTrailingNul(text: string): string {
  const end = text.indexOf(NUL);
  return end >= 0 ? text.slice(0, end) : text;
}

/** Testo ID3 nella codifica data (0 Latin-1, 1 UTF-16 con BOM, 2 UTF-16BE, 3 UTF-8), a capo compresi. */
function decodeLyricsText(bytes: Uint8Array, encoding: number): string {
  if (encoding === 0) return withoutTrailingNul(decodeLatin1(bytes, MAX_LYRICS_BYTES));
  if (encoding === 3) return withoutTrailingNul(decodeUtf8(bytes, MAX_LYRICS_BYTES));
  if (encoding === 1) return withoutTrailingNul(decodeUtf16WithBom(bytes, true, MAX_LYRICS_BYTES));
  return withoutTrailingNul(decodeUtf16(bytes, false, MAX_LYRICS_BYTES));
}

/** USLT/ULT: codifica, lingua (3), descrizione terminata, poi il testo. */
export function parseUsltFrame(data: Uint8Array): string | null {
  if (data.length < 5) return null;
  const encoding = byteAt(data, 0);
  if (encoding > 3) return null;
  const start = afterTerminator(data, 4, encoding === 1 || encoding === 2);
  if (start < 0) return null;
  const text = decodeLyricsText(data.subarray(start), encoding);
  return text.trim() ? text : null;
}

/** Descrizioni dei frame TXXX con il testo: ffmpeg (e chi lo usa) scrive lì il testo degli MP3. */
const TXXX_LYRICS_DESCRIPTIONS = new Set(['USLT', 'LYRICS', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS']);

/** TXXX/TXX: codifica, descrizione terminata, valore. Il valore solo se la descrizione è un testo. */
export function parseTxxxLyricsFrame(data: Uint8Array): string | null {
  if (data.length < 3) return null;
  const encoding = byteAt(data, 0);
  if (encoding > 3) return null;
  const wide = encoding === 1 || encoding === 2;
  const start = afterTerminator(data, 1, wide);
  if (start < 0) return null;
  const description = decodeLyricsText(data.subarray(1, start - (wide ? 2 : 1)), encoding);
  if (!TXXX_LYRICS_DESCRIPTIONS.has(description.trim().toUpperCase())) return null;
  const text = decodeLyricsText(data.subarray(start), encoding);
  return text.trim() ? text : null;
}

/**
 * SYLT/SLT: codifica, lingua (3), formato dei tempi (1 = frame MPEG, 2 = millisecondi), tipo di
 * contenuto, descrizione terminata, poi coppie [testo terminato + tempo a 32 bit].
 */
export function parseSyltFrame(data: Uint8Array): ParsedLyrics | null {
  if (data.length < 7) return null;
  const encoding = byteAt(data, 0);
  if (encoding > 3) return null;
  const wide = encoding === 1 || encoding === 2;
  const format = byteAt(data, 4);
  let pos = afterTerminator(data, 6, wide);
  if (pos < 0) return null;
  const entries: SyncTextEntry[] = [];
  while (pos < data.length && entries.length < MAX_SYLT_ENTRIES) {
    const end = afterTerminator(data, pos, wide);
    if (end < 0 || end + 4 > data.length) break;
    const text = decodeLyricsText(data.subarray(pos, end - (wide ? 2 : 1)), encoding);
    entries.push({ text, timestamp: readUint32(data, end) });
    pos = end + 4;
  }
  if (entries.length === 0) return null;
  if (format === 2) return lyricsFromSyncText(entries);
  // Tempi in frame MPEG: non convertibili senza decodificare l'audio. Solo il testo.
  const separated = entries.some((entry) => /[\r\n]/.test(entry.text ?? ''));
  return parseLyrics(entries.map((entry) => entry.text ?? '').join(separated ? '' : '\n'));
}

/**
 * Testo da un tag ID3v2 completo in memoria: SYLT in ms, poi USLT (anche LRC), poi SYLT a frame;
 * solo se non c'è nessuno di questi, un TXXX/TXX "USLT"/"LYRICS" (come lo scrive ffmpeg).
 */
export function lyricsFromId3v2(bytes: Uint8Array): ParsedLyrics | null {
  const found: {
    syncedMs: ParsedLyrics | null;
    unsynced: ParsedLyrics | null;
    syncedFrames: ParsedLyrics | null;
    userText: ParsedLyrics | null;
  } = { syncedMs: null, unsynced: null, syncedFrames: null, userText: null };
  try {
    walkId3v2Frames(bytes, (frame) => {
      if (frame.id === 'SYLT' || frame.id === 'SLT') {
        const data = frame.data();
        const parsed = data ? parseSyltFrame(data) : null;
        if (data && parsed) {
          if (byteAt(data, 4) === 2 && parsed.kind === 'synced') found.syncedMs ??= parsed;
          else found.syncedFrames ??= parsed;
        }
      } else if ((frame.id === 'USLT' || frame.id === 'ULT') && !found.unsynced) {
        const data = frame.data();
        const text = data ? parseUsltFrame(data) : null;
        if (text) found.unsynced = parseLyrics(text);
      } else if ((frame.id === 'TXXX' || frame.id === 'TXX') && !found.userText) {
        const data = frame.data();
        const text = data ? parseTxxxLyricsFrame(data) : null;
        if (text) found.userText = parseLyrics(text);
      }
      // Un testo sincronizzato in millisecondi è il migliore possibile: inutile continuare.
      return found.syncedMs !== null;
    });
  } catch {
    // Tag malformato: si usa quanto trovato.
  }
  if (found.syncedMs) return found.syncedMs;
  if (found.unsynced?.kind === 'synced') return found.unsynced;
  return found.unsynced ?? found.syncedFrames ?? found.userText;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    byteAt(bytes, offset) +
    byteAt(bytes, offset + 1) * 0x100 +
    byteAt(bytes, offset + 2) * 0x10000 +
    byteAt(bytes, offset + 3) * 0x1000000
  );
}

/** Valore LYRICS (o UNSYNCEDLYRICS) dal corpo di un blocco VORBIS_COMMENT, o null. */
export function lyricsFromVorbisComments(block: Uint8Array): string | null {
  if (block.length < 8) return null;
  let pos = 4 + readUint32LE(block, 0); // vendor
  if (pos + 4 > block.length) return null;
  const count = readUint32LE(block, pos);
  pos += 4;
  let unsynced: string | null = null;
  for (let index = 0; index < count && index < 4096 && pos + 4 <= block.length; index += 1) {
    const length = readUint32LE(block, pos);
    pos += 4;
    if (length > block.length - pos) break;
    const comment = block.subarray(pos, pos + length);
    pos += length;
    const equals = comment.indexOf(0x3d);
    if (equals <= 0 || equals > 64) continue;
    const key = decodeLatin1(comment.subarray(0, equals), 64).toUpperCase();
    if (key !== 'LYRICS' && key !== 'UNSYNCEDLYRICS' && key !== 'UNSYNCED LYRICS') continue;
    const value = decodeUtf8(comment.subarray(equals + 1), MAX_LYRICS_BYTES);
    if (!value.trim()) continue;
    if (key === 'LYRICS') return value;
    unsynced ??= value;
  }
  return unsynced;
}

/** Il testo dei commenti Vorbis di un FLAC, leggendo solo gli header dei blocchi e quel blocco. */
async function readFlacLyricsText(read: ByteReader, size: number): Promise<string | null> {
  let position = 4;
  for (let blocks = 0; blocks < MAX_FLAC_BLOCKS && position + 4 <= size; blocks += 1) {
    const header = await read(position, position + 4);
    if (header.length < 4) return null;
    const last = (byteAt(header, 0) & 0x80) !== 0;
    const type = byteAt(header, 0) & 0x7f;
    const length = byteAt(header, 1) * 0x10000 + byteAt(header, 2) * 0x100 + byteAt(header, 3);
    if (type === 127) return null;
    if (type === 4) {
      if (length > MAX_TAG_BYTES) return null;
      const block = await read(position + 4, position + 4 + length);
      return block.length >= length ? lyricsFromVorbisComments(block) : null;
    }
    if (last) return null;
    position += 4 + length;
  }
  return null;
}

function isFlac(head: Uint8Array): boolean {
  return (
    byteAt(head, 0) === 0x66 &&
    byteAt(head, 1) === 0x4c &&
    byteAt(head, 2) === 0x61 &&
    byteAt(head, 3) === 0x43
  );
}

/** Testo incorporato in un file audio del dispositivo (MP3, M4A/MP4, FLAC), o null. Mai throw. */
export async function readLocalLyrics(blob: Blob): Promise<ParsedLyrics | null> {
  try {
    const size = blob.size;
    if (!Number.isFinite(size) || size <= 0) return null;
    const read = blobByteReader(blob);
    const head = await read(0, 16);
    const id3 = readId3v2Header(head);
    if (id3) return lyricsFromId3v2(await read(0, Math.min(id3.totalSize, MAX_TAG_BYTES)));
    if (looksLikeMp4(head)) return parseLyrics(await readMp4LyricsText(read, size));
    if (isFlac(head)) return parseLyrics(await readFlacLyricsText(read, size));
    return null;
  } catch {
    return null;
  }
}

/**
 * Il testo di un brano di "La tua musica" per il player: solo un file dell'ascoltatore (fonte
 * 'local', mai un download Audius o podcast né la copia di un brano in evidenza), letto dal
 * dispositivo. null se non c'è. La fonte è quella del record in IndexedDB (reader.ts): per un
 * brano scaricato il file non viene nemmeno aperto.
 */
export async function loadLocalLyrics(
  id: string,
  reader: Pick<LocalMusicReader, 'getTrack' | 'getTrackBlob'> = getLocalMusicReader(),
): Promise<Lyrics | null> {
  try {
    const track = await reader.getTrack(id);
    // Qualunque download (Audius, podcast, brano in evidenza): niente testo dai tag del file.
    if (!track || localTrackSource(track) !== 'local') return null;
    const blob = await reader.getTrackBlob(id);
    if (!blob) return null;
    const parsed = await readLocalLyrics(blob);
    if (!parsed) return null;
    return { kind: parsed.kind, lines: parsed.lines, source: 'local', credit: LYRICS_CREDIT_LOCAL };
  } catch {
    return null;
  }
}
