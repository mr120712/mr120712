// @polsia:user-owned — lettore difensivo dei tag iTunes ('ilst') dei file M4A/MP4 locali.
//
// Percorso: moov → udta → meta → ilst (e moov → meta, stile QuickTime), voci ©nam/©ART/©alb/covr
// con aART (artista dell'album) come riserva; da moov → mvhd anche la durata. Su un Blob i box di
// primo livello e i figli di moov si scorrono leggendo solo i loro header (16 byte): 'mdat', cioè
// l'audio, non viene mai letto, anche quando moov sta in fondo al file. Poi si leggono solo mvhd
// (pochi byte), il primo udta e il primo meta di moov, con un budget complessivo di MAX_TAG_BYTES
// (2 MiB) e fermandosi appena titolo, artista, album e copertina sono trovati. Input non fidato:
// dimensioni a 32 e 64 bit, box troncati e dimensioni false sono controllati; nessuna eccezione
// esce da qui.

import {
  acceptArtwork,
  type ByteReader,
  byteAt,
  decodeMp4Text,
  decodeUtf8,
  decodeUtf16WithBom,
  finalizeTags,
  MAX_TAG_BYTES,
  plausibleDuration,
  readUint32,
  type TagDraft,
} from '@/lib/local-music/tag-utils';
import type { AudioTags } from '@/lib/local-music/types';

/** Box esaminati al massimo per livello: un file vero ne ha pochi. */
const MAX_BOXES = 256;
/** Byte letti al massimo per mvhd (versione 1 con header a 64 bit: 48 byte utili). */
const MAX_MVHD_BYTES = 256;
/** Figli di moov letti, in quest'ordine: la durata (mvhd) prima, poi i tag. */
const MOOV_CHILDREN = ['mvhd', 'udta', 'meta'] as const;

export type Mp4Box = {
  type: string;
  /** Offset del box (coordinate del contenitore in cui è stato letto). */
  start: number;
  headerSize: number;
  /** Fine dichiarata del box: può superare i byte disponibili se il file è troncato. */
  end: number;
};

function boxTypeAt(bytes: Uint8Array, at: number): string | null {
  if (at + 4 > bytes.length) return null;
  let type = '';
  for (let i = 0; i < 4; i++) {
    const c = byteAt(bytes, at + i);
    if ((c < 0x20 || c > 0x7e) && c !== 0xa9) return null;
    type += String.fromCharCode(c);
  }
  return type;
}

/**
 * Header del box che inizia a `offset`; `head` contiene i byte da `offset` in poi (ne bastano 16).
 * Dimensione 1 = 64 bit, 0 = fino a `containerEnd`. null se l'header non è valido.
 */
export function parseBoxHeader(
  head: Uint8Array,
  offset: number,
  containerEnd: number,
): Mp4Box | null {
  if (head.length < 8) return null;
  const type = boxTypeAt(head, 4);
  if (!type) return null;
  const size32 = readUint32(head, 0);
  let headerSize = 8;
  let size: number;
  if (size32 === 1) {
    if (head.length < 16) return null;
    size = readUint32(head, 8) * 0x100000000 + readUint32(head, 12);
    headerSize = 16;
  } else if (size32 === 0) {
    size = containerEnd - offset;
  } else {
    size = size32;
  }
  if (!Number.isSafeInteger(size) || size < headerSize) return null;
  return { type, start: offset, headerSize, end: offset + size };
}

function contentStart(box: Mp4Box): number {
  return box.start + box.headerSize;
}

/** Figli in memoria tra `start` e `end` (fermi ai byte disponibili e al primo header rotto). */
function* childBoxes(bytes: Uint8Array, start: number, end: number): Generator<Mp4Box> {
  const limit = Math.min(end, bytes.length);
  let pos = start;
  for (let n = 0; n < MAX_BOXES && pos + 8 <= limit; n++) {
    const box = parseBoxHeader(bytes.subarray(pos, pos + 16), pos, end);
    if (!box) return;
    yield box;
    pos = box.end;
  }
}

const ITEM_FIELDS: Record<string, 'title' | 'artist' | 'albumArtist' | 'album' | 'artwork'> = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'albumArtist',
  '©alb': 'album',
  covr: 'artwork',
};

function readIlst(bytes: Uint8Array, ilst: Mp4Box, draft: TagDraft): void {
  for (const item of childBoxes(bytes, contentStart(ilst), ilst.end)) {
    const field = ITEM_FIELDS[item.type];
    if (!field || draft[field]) continue;
    for (const data of childBoxes(bytes, contentStart(item), item.end)) {
      // Un valore troncato (lettura limitata o file rovinato) non è usabile.
      if (data.type !== 'data' || data.end > bytes.length) continue;
      const payload = contentStart(data);
      if (data.end - payload < 8) continue;
      const typeCode = readUint32(bytes, payload) & 0xffffff;
      const value = bytes.subarray(payload + 8, data.end);
      if (field === 'artwork') {
        const image = acceptArtwork(value);
        if (image) draft.artwork = image;
      } else {
        const text = decodeMp4Text(value, typeCode);
        if (text) draft[field] = text;
      }
      if (draft[field]) break;
    }
  }
}

function readMeta(bytes: Uint8Array, meta: Mp4Box, draft: TagDraft): void {
  const start = contentStart(meta);
  // ISO: 'meta' è un full box (versione + flag, 4 byte) seguito da 'hdlr'. QuickTime: niente
  // versione, 'hdlr' subito.
  const first = boxTypeAt(bytes, start + 4) === 'hdlr' ? start : start + 4;
  for (const child of childBoxes(bytes, first, meta.end)) {
    if (child.type === 'ilst') readIlst(bytes, child, draft);
  }
}

function readUdta(bytes: Uint8Array, udta: Mp4Box, draft: TagDraft): void {
  for (const child of childBoxes(bytes, contentStart(udta), udta.end)) {
    if (child.type === 'meta') readMeta(bytes, child, draft);
  }
}

function readMvhd(bytes: Uint8Array, mvhd: Mp4Box, draft: TagDraft): void {
  const s = contentStart(mvhd);
  const end = Math.min(mvhd.end, bytes.length);
  const version = byteAt(bytes, s);
  let timescale: number;
  let duration: number;
  if (version === 0 && s + 20 <= end) {
    timescale = readUint32(bytes, s + 12);
    duration = readUint32(bytes, s + 16);
    if (duration === 0xffffffff) return; // durata sconosciuta
  } else if (version === 1 && s + 32 <= end) {
    timescale = readUint32(bytes, s + 20);
    duration = readUint32(bytes, s + 24) * 0x100000000 + readUint32(bytes, s + 28);
  } else {
    return;
  }
  if (timescale <= 0) return;
  const seconds = plausibleDuration(duration / timescale);
  if (seconds !== null) draft.durationSeconds = seconds;
}

function readMoovChild(bytes: Uint8Array, box: Mp4Box, draft: TagDraft): void {
  if (box.type === 'mvhd') readMvhd(bytes, box, draft);
  else if (box.type === 'udta') readUdta(bytes, box, draft);
  else if (box.type === 'meta') readMeta(bytes, box, draft);
}

/** Tag di un MP4/M4A già in memoria (anche solo l'inizio del file). Mai un'eccezione. */
export function parseMp4Tags(bytes: Uint8Array): AudioTags {
  const draft: TagDraft = {};
  try {
    for (const box of childBoxes(bytes, 0, bytes.length)) {
      if (box.type !== 'moov') continue;
      for (const child of childBoxes(bytes, contentStart(box), box.end)) {
        readMoovChild(bytes, child, draft);
      }
      break;
    }
  } catch {
    // Box malformati: si tiene quanto letto.
  }
  return finalizeTags(draft);
}

/**
 * Scorre i box tra `start` e `end` leggendo solo i loro header e restituisce il primo box di
 * ciascun tipo cercato, nell'ordine di `wanted`; si ferma appena li ha trovati tutti.
 */
async function scanBoxes(
  read: ByteReader,
  start: number,
  end: number,
  wanted: readonly string[],
): Promise<Mp4Box[]> {
  const found = new Map<string, Mp4Box>();
  let pos = start;
  for (let n = 0; n < MAX_BOXES && pos + 8 <= end && found.size < wanted.length; n++) {
    const head = await read(pos, Math.min(pos + 16, end));
    const box = parseBoxHeader(head, pos, end);
    if (!box) break;
    if (wanted.includes(box.type) && !found.has(box.type)) found.set(box.type, box);
    pos = box.end;
  }
  return wanted.flatMap((type) => found.get(type) ?? []);
}

function tagsComplete(draft: TagDraft): boolean {
  return Boolean(draft.title && draft.artist && draft.album && draft.artwork);
}

/**
 * Tag di un MP4/M4A di `size` byte letto a pezzi con `read` (tipicamente Blob.slice): solo
 * header, mvhd e i box dei tag (2 MiB in tutto), mai l'audio. Mai un'eccezione.
 */
export async function readMp4Tags(read: ByteReader, size: number): Promise<AudioTags> {
  const draft: TagDraft = {};
  try {
    const [moov] = await scanBoxes(read, 0, size, ['moov']);
    if (!moov) return finalizeTags(draft);
    const moovEnd = Math.min(moov.end, size);
    const children = await scanBoxes(read, contentStart(moov), moovEnd, MOOV_CHILDREN);
    let budget = MAX_TAG_BYTES;
    for (const child of children) {
      if (child.type !== 'mvhd' && tagsComplete(draft)) break;
      const cap = child.type === 'mvhd' ? MAX_MVHD_BYTES : MAX_TAG_BYTES;
      const length = Math.min(Math.min(child.end, moovEnd) - child.start, cap, budget);
      if (length < child.headerSize) break;
      budget -= length;
      const bytes = await read(child.start, child.start + length);
      // Il box riletto in coordinate locali (0 = inizio del box).
      const local = parseBoxHeader(bytes, 0, child.end - child.start);
      if (local && local.type === child.type) readMoovChild(bytes, local, draft);
    }
  } catch {
    // Lettura fallita o box malformati: si tiene quanto letto.
  }
  return finalizeTags(draft);
}

/** Byte massimi del valore ©lyr (testo del brano) decodificati. */
const MAX_LYRICS_VALUE_BYTES = 512 * 1024;

/** Valore grezzo (byte e tipo) della voce `type` dentro 'ilst', o null. */
function ilstValue(
  bytes: Uint8Array,
  ilst: Mp4Box,
  type: string,
): { value: Uint8Array; typeCode: number } | null {
  for (const item of childBoxes(bytes, contentStart(ilst), ilst.end)) {
    if (item.type !== type) continue;
    for (const data of childBoxes(bytes, contentStart(item), item.end)) {
      if (data.type !== 'data' || data.end > bytes.length) continue;
      const payload = contentStart(data);
      if (data.end - payload < 8) continue;
      return {
        typeCode: readUint32(bytes, payload) & 0xffffff,
        value: bytes.subarray(payload + 8, data.end),
      };
    }
  }
  return null;
}

/** Il testo ©lyr in un box 'udta' o 'meta' già in memoria (coordinate locali), o null. */
function lyricsInBox(bytes: Uint8Array, box: Mp4Box): string | null {
  if (box.type === 'udta') {
    for (const child of childBoxes(bytes, contentStart(box), box.end)) {
      if (child.type !== 'meta') continue;
      const text = lyricsInBox(bytes, child);
      if (text) return text;
    }
    return null;
  }
  if (box.type !== 'meta') return null;
  const start = contentStart(box);
  const first = boxTypeAt(bytes, start + 4) === 'hdlr' ? start : start + 4;
  for (const child of childBoxes(bytes, first, box.end)) {
    if (child.type !== 'ilst') continue;
    const found = ilstValue(bytes, child, '©lyr');
    if (!found) continue;
    // Tipo 2 = UTF-16BE; gli altri si leggono come UTF-8. Il testo intero, a capo compresi.
    const text =
      found.typeCode === 2
        ? decodeUtf16WithBom(found.value, false, MAX_LYRICS_VALUE_BYTES)
        : decodeUtf8(found.value, MAX_LYRICS_VALUE_BYTES);
    const end = text.indexOf(String.fromCharCode(0));
    return end >= 0 ? text.slice(0, end) : text;
  }
  return null;
}

/**
 * Testo del brano (voce iTunes '©lyr') di un MP4/M4A di `size` byte, letto a pezzi come i tag:
 * solo header, il primo udta e il primo meta di moov (al massimo MAX_TAG_BYTES), mai l'audio.
 * Testo grezzo (LRC o semplice) da passare a parseLyrics; null se assente. Mai un'eccezione.
 */
export async function readMp4LyricsText(read: ByteReader, size: number): Promise<string | null> {
  try {
    const [moov] = await scanBoxes(read, 0, size, ['moov']);
    if (!moov) return null;
    const moovEnd = Math.min(moov.end, size);
    const children = await scanBoxes(read, contentStart(moov), moovEnd, ['udta', 'meta']);
    let budget = MAX_TAG_BYTES;
    for (const child of children) {
      const length = Math.min(Math.min(child.end, moovEnd) - child.start, MAX_TAG_BYTES, budget);
      if (length < child.headerSize) break;
      budget -= length;
      const bytes = await read(child.start, child.start + length);
      const local = parseBoxHeader(bytes, 0, child.end - child.start);
      if (!local || local.type !== child.type) continue;
      const text = lyricsInBox(bytes, local);
      if (text) return text;
    }
  } catch {
    // Lettura fallita o box malformati: nessun testo.
  }
  return null;
}

/** True se `head` (inizio del file) ha la firma 'ftyp' degli MP4/M4A. */
export function looksLikeMp4(head: Uint8Array): boolean {
  return boxTypeAt(head, 4) === 'ftyp' && parseBoxHeader(head, 0, Number.MAX_SAFE_INTEGER) !== null;
}
