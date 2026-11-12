// @polsia:user-owned — lettore difensivo dei tag ID3 (v2.2, v2.3, v2.4 e v1) degli MP3 locali.
//
// Legge solo titolo, artista, album e copertina: TIT2/TPE1/TALB/APIC (v2.3/2.4) e
// TT2/TP1/TAL/PIC (v2.2), con TPE2/TP2 (artista dell'album) come riserva per l'artista.
// Gestisce dimensioni syncsafe (anche quelle non syncsafe scritte da vecchi iTunes in v2.4), la
// desincronizzazione (dell'intero tag in v2.2/2.3, per frame in v2.4), l'header esteso, il footer
// v2.4 e le codifiche ISO-8859-1, UTF-16 con BOM, UTF-16BE e UTF-8. I frame compressi o cifrati
// sono saltati. Input non fidato: ogni lunghezza è confrontata con i byte presenti e nessuna
// eccezione esce da qui; un tag rovinato restituisce quello che si è potuto leggere.

import {
  acceptArtwork,
  byteAt,
  decodeId3Text,
  decodeLatin1,
  finalizeTags,
  readUint32,
  sanitizeTagText,
  type TagDraft,
} from '@/lib/local-music/tag-utils';
import { type ArtworkImage, type AudioTags, emptyTags } from '@/lib/local-music/types';

export const ID3V2_HEADER_BYTES = 10;
export const ID3V1_BYTES = 128;
const MAX_FRAMES = 1024;

export type Id3v2Header = {
  major: 2 | 3 | 4;
  flags: number;
  /** Dimensione del tag dopo l'header (syncsafe), footer escluso. */
  size: number;
  /** Byte totali del tag dall'inizio del file: header + tag + footer v2.4. */
  totalSize: number;
};

function readSyncsafe(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const b = byteAt(bytes, offset + i);
    if (b & 0x80) return null;
    value = value * 128 + b;
  }
  return value;
}

/** Header ID3v2 all'inizio di `bytes`, o null se non c'è un tag ID3v2.2/2.3/2.4 valido. */
export function readId3v2Header(bytes: Uint8Array): Id3v2Header | null {
  if (bytes.length < ID3V2_HEADER_BYTES) return null;
  if (byteAt(bytes, 0) !== 0x49 || byteAt(bytes, 1) !== 0x44 || byteAt(bytes, 2) !== 0x33) {
    return null;
  }
  const major = byteAt(bytes, 3);
  if (major !== 2 && major !== 3 && major !== 4) return null;
  if (byteAt(bytes, 4) === 0xff) return null;
  const size = readSyncsafe(bytes, 6);
  if (size === null) return null;
  const flags = byteAt(bytes, 5);
  const footer = major === 4 && (flags & 0x10) !== 0 ? ID3V2_HEADER_BYTES : 0;
  return { major, flags, size, totalSize: ID3V2_HEADER_BYTES + size + footer };
}

/** Toglie lo 0x00 inserito dopo ogni 0xFF dalla desincronizzazione ID3. */
export function removeUnsynchronisation(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = byteAt(bytes, i);
    out[j] = b;
    j += 1;
    if (b === 0xff && i + 1 < bytes.length && byteAt(bytes, i + 1) === 0x00) i += 1;
  }
  return out.subarray(0, j);
}

type FrameHeader = { id: string; formatFlags: number; dataStart: number; dataEnd: number };

function readFrameId(body: Uint8Array, at: number, length: number): string | null {
  if (at + length > body.length) return null;
  let id = '';
  for (let i = 0; i < length; i++) {
    const c = byteAt(body, at + i);
    const upper = c >= 0x41 && c <= 0x5a;
    const digit = c >= 0x30 && c <= 0x39;
    if (!upper && !digit) return null;
    id += String.fromCharCode(c);
  }
  return id;
}

/** Confine certo dopo un frame v2.4: fine esatta del tag o header di un altro frame. */
function isFrameEnd(body: Uint8Array, at: number): boolean {
  if (at === body.length) return true;
  return at + 10 <= body.length && readFrameId(body, at, 4) !== null;
}

/**
 * Padding vero: da `at` alla fine del tag solo byte zero. Un singolo 0x00 non basta, perché è
 * comunissimo dentro il testo UTF-16 e nelle immagini.
 */
function isPadding(body: Uint8Array, at: number): boolean {
  if (at >= body.length) return false;
  for (let i = at; i < body.length; i++) {
    if (byteAt(body, i) !== 0) return false;
  }
  return true;
}

/**
 * Dimensione di un frame v2.4: syncsafe, ma i vecchi iTunes la scrivevano come intero normale.
 * Vince la lettura che finisce su un confine certo (fine del tag o frame successivo), poi quella
 * seguita da padding; nel dubbio vale lo standard (syncsafe).
 */
function v24FrameSize(body: Uint8Array, pos: number): number {
  const raw = readUint32(body, pos + 4);
  const syncsafe = readSyncsafe(body, pos + 4);
  if (syncsafe === null) return raw;
  if (syncsafe === raw) return syncsafe;
  const dataStart = pos + 10;
  if (isFrameEnd(body, dataStart + syncsafe)) return syncsafe;
  if (isFrameEnd(body, dataStart + raw)) return raw;
  if (isPadding(body, dataStart + syncsafe)) return syncsafe;
  if (isPadding(body, dataStart + raw)) return raw;
  return syncsafe;
}

function readFrameHeader(body: Uint8Array, pos: number, major: 2 | 3 | 4): FrameHeader | null {
  const headerLength = major === 2 ? 6 : 10;
  if (pos + headerLength > body.length) return null;
  // Un NUL o un identificativo non valido: padding o spazzatura, fine dei frame.
  const id = readFrameId(body, pos, major === 2 ? 3 : 4);
  if (!id) return null;
  let size: number;
  if (major === 2) {
    size = byteAt(body, pos + 3) * 0x10000 + byteAt(body, pos + 4) * 0x100 + byteAt(body, pos + 5);
  } else if (major === 3) {
    size = readUint32(body, pos + 4);
  } else {
    size = v24FrameSize(body, pos);
  }
  const dataStart = pos + headerLength;
  const dataEnd = dataStart + size;
  // Frame che dichiara più byte di quelli presenti (tag troncato o dimensione falsa): stop.
  if (dataEnd > body.length) return null;
  return { id, formatFlags: major === 2 ? 0 : byteAt(body, pos + 9), dataStart, dataEnd };
}

/** Dati utili del frame, o null se compresso/cifrato (non supportato). */
function frameData(
  body: Uint8Array,
  frame: FrameHeader,
  major: 2 | 3 | 4,
  tagUnsync: boolean,
): Uint8Array | null {
  let data = body.subarray(frame.dataStart, frame.dataEnd);
  const flags = frame.formatFlags;
  if (major === 3) {
    if (flags & 0xc0) return null; // compressione o cifratura
    if (flags & 0x20) data = data.subarray(1); // identificativo di gruppo
  } else if (major === 4) {
    if (flags & 0x0c) return null; // compressione o cifratura
    if (flags & 0x02 || tagUnsync) data = removeUnsynchronisation(data);
    let skip = 0;
    if (flags & 0x40) skip += 1; // identificativo di gruppo
    if (flags & 0x01) skip += 4; // indicatore di lunghezza
    data = data.subarray(skip);
  }
  return data;
}

/** Indice subito dopo il terminatore della descrizione (NUL o doppio NUL allineato), o -1. */
function afterTerminator(data: Uint8Array, start: number, wide: boolean): number {
  if (!wide) {
    const index = data.indexOf(0, start);
    return index < 0 ? -1 : index + 1;
  }
  for (let i = start; i + 1 < data.length; i += 2) {
    if (byteAt(data, i) === 0 && byteAt(data, i + 1) === 0) return i + 2;
  }
  return -1;
}

/** APIC (v2.3/2.4) o PIC (v2.2): tipo immagine dichiarato ignorato, decide la firma dei byte. */
function readPicture(
  data: Uint8Array,
  v22: boolean,
): { image: ArtworkImage; front: boolean } | null {
  if (data.length < 4) return null;
  const encoding = byteAt(data, 0);
  if (encoding > 3) return null;
  let pos: number;
  if (v22) {
    pos = 4; // codifica (1) + formato immagine (3)
  } else {
    const mimeEnd = data.indexOf(0, 1);
    if (mimeEnd < 0) return null;
    pos = mimeEnd + 1;
  }
  if (pos >= data.length) return null;
  const pictureType = byteAt(data, pos);
  const imageStart = afterTerminator(data, pos + 1, encoding === 1 || encoding === 2);
  if (imageStart < 0) return null;
  const image = acceptArtwork(data.subarray(imageStart));
  return image ? { image, front: pictureType === 3 } : null;
}

type FrameField = 'title' | 'artist' | 'albumArtist' | 'album' | 'picture';

const FRAME_FIELDS: Record<string, FrameField> = {
  TT2: 'title',
  TIT2: 'title',
  TP1: 'artist',
  TPE1: 'artist',
  TP2: 'albumArtist',
  TPE2: 'albumArtist',
  TAL: 'album',
  TALB: 'album',
  PIC: 'picture',
  APIC: 'picture',
};

function readFrames(input: Uint8Array, draft: TagDraft): void {
  const header = readId3v2Header(input);
  if (!header) return;
  const { major, flags } = header;
  // v2.2 con il bit di compressione: nessuno schema definito, il tag va ignorato.
  if (major === 2 && flags & 0x40) return;
  const tagUnsync = (flags & 0x80) !== 0;
  let body = input.subarray(ID3V2_HEADER_BYTES, ID3V2_HEADER_BYTES + header.size);
  if (tagUnsync && major !== 4) body = removeUnsynchronisation(body);

  let pos = 0;
  if (major !== 2 && flags & 0x40) {
    if (body.length < 4) return;
    // v2.3: dimensione normale, esclusi i suoi 4 byte. v2.4: syncsafe, inclusi.
    const extended = major === 3 ? readUint32(body, 0) + 4 : readSyncsafe(body, 0);
    if (extended === null || extended < (major === 3 ? 10 : 6) || extended > body.length) return;
    pos = extended;
  }

  for (let count = 0; count < MAX_FRAMES; count++) {
    const frame = readFrameHeader(body, pos, major);
    if (!frame) break;
    pos = frame.dataEnd;
    const field = FRAME_FIELDS[frame.id];
    if (!field) continue;
    if (field === 'picture' && draft.artworkIsFront) continue;
    if (field !== 'picture' && draft[field]) continue;
    const data = frameData(body, frame, major, tagUnsync);
    if (!data || data.length === 0) continue;

    if (field === 'picture') {
      const picture = readPicture(data, major === 2);
      if (picture && (!draft.artwork || picture.front)) {
        draft.artwork = picture.image;
        draft.artworkIsFront = picture.front;
      }
      continue;
    }
    const values = decodeId3Text(data.subarray(1), byteAt(data, 0));
    if (values.length === 0) continue;
    if (field === 'artist') {
      // Più artisti (valori separati da NUL in v2.4) in una sola riga.
      draft.artist = sanitizeTagText(values.join(', ')) ?? undefined;
    } else {
      draft[field] = values[0];
    }
  }
}

/** Tag ID3v2 all'inizio di `bytes` (anche troncati); mai un'eccezione. */
export function parseId3v2(bytes: Uint8Array): AudioTags {
  const draft: TagDraft = {};
  try {
    readFrames(bytes, draft);
  } catch {
    // Tag malformato: si tiene quanto letto finora.
  }
  return finalizeTags(draft);
}

function id3v1Field(tag: Uint8Array, start: number, length: number): string | null {
  const raw = tag.subarray(start, start + length);
  const end = raw.indexOf(0);
  return sanitizeTagText(decodeLatin1(end < 0 ? raw : raw.subarray(0, end)));
}

/** Tag ID3v1 negli ultimi 128 byte di `bytes` ("TAG" + campi Latin-1 da 30 byte). */
export function parseId3v1(bytes: Uint8Array): AudioTags {
  const tags = emptyTags();
  if (bytes.length < ID3V1_BYTES) return tags;
  const tag = bytes.subarray(bytes.length - ID3V1_BYTES);
  if (byteAt(tag, 0) !== 0x54 || byteAt(tag, 1) !== 0x41 || byteAt(tag, 2) !== 0x47) return tags;
  tags.title = id3v1Field(tag, 3, 30);
  tags.artist = id3v1Field(tag, 33, 30);
  tags.album = id3v1Field(tag, 63, 30);
  return tags;
}
