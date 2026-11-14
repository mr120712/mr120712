// @polsia:user-owned — copertina INCORPORATA in un file audio (quella che si vede nei lettori):
// tag ID3v2 degli MP3 (frame APIC/PIC) e blocco PICTURE dei FLAC. Solo lettura e parsing, senza
// dipendenze: il chiamante fornisce `read(start, end)` (richieste Range sullo storage), così si
// scaricano solo i byte del tag, mai l'intero brano. Ogni dato è validato: dimensioni massime e
// firma reale dell'immagine (JPEG/PNG/WebP/GIF), mai il tipo dichiarato dal file.

/** Tag o immagine più grandi di così: si rinuncia (niente download enormi). */
export const MAX_ARTWORK_TAG_BYTES = 8 * 1024 * 1024;
/** Primo blocco letto in un'unica richiesta: basta per l'intestazione e spesso per tutto il tag. */
export const ARTWORK_HEAD_BYTES = 64 * 1024;

export type EmbeddedArtwork = { contentType: string; data: Uint8Array };

/** Legge i byte [start, end] (estremi inclusi) del file. Può restituirne meno a fine file. */
export type ByteRangeReader = (start: number, end: number) => Promise<Uint8Array>;

/** Tipo reale dell'immagine dai primi byte, o null se non è un formato ammesso. */
export function sniffImageType(data: Uint8Array): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (data.length >= 12 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (data.length >= 6 && (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  return null;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = offset; i < offset + length && i < data.length; i += 1) {
    out += String.fromCharCode(data[i] ?? 0);
  }
  return out;
}

function syncsafe(data: Uint8Array, offset: number): number {
  return (
    (((data[offset] ?? 0) & 0x7f) << 21) |
    (((data[offset + 1] ?? 0) & 0x7f) << 14) |
    (((data[offset + 2] ?? 0) & 0x7f) << 7) |
    ((data[offset + 3] ?? 0) & 0x7f)
  );
}

function uint32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) * 0x1000000 +
      (((data[offset + 1] ?? 0) << 16) |
        ((data[offset + 2] ?? 0) << 8) |
        (data[offset + 3] ?? 0))) >>>
    0
  );
}

function uint24(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
}

/** Toglie la "unsynchronisation" ID3 (ogni 0xFF 0x00 torna 0xFF). */
function deunsynchronise(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let length = 0;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    out[length] = byte;
    length += 1;
    if (byte === 0xff && data[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, length);
}

/** Lunghezza totale del tag ID3v2 (intestazione e piè di pagina compresi), o null se manca. */
export function id3TagLength(head: Uint8Array): number | null {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return null;
  const major = head[3] ?? 0;
  if (major < 2 || major > 4 || head[4] === 0xff) return null;
  for (let i = 6; i < 10; i += 1) if (((head[i] ?? 0) & 0x80) !== 0) return null;
  const footer = major === 4 && ((head[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + syncsafe(head, 6) + footer;
}

/** Fine (indice escluso) di una stringa terminata da zero nella codifica ID3 data. */
function textEnd(data: Uint8Array, offset: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    // UTF-16: terminatore di due byte, allineato.
    for (let i = offset; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) return i + 2;
    }
    return -1;
  }
  for (let i = offset; i < data.length; i += 1) if (data[i] === 0) return i + 1;
  return -1;
}

type Candidate = { pictureType: number; data: Uint8Array };

function pictureFromApic(body: Uint8Array, v22: boolean): Candidate | null {
  if (body.length < 4) return null;
  const encoding = body[0] ?? 0;
  let offset = 1;
  if (v22) {
    offset += 3; // formato a tre lettere ("JPG", "PNG"): ignorato, conta la firma reale.
  } else {
    const mimeEnd = textEnd(body, offset, 0);
    if (mimeEnd < 0) return null;
    if (ascii(body, offset, mimeEnd - offset - 1) === '-->') return null; // solo un link
    offset = mimeEnd;
  }
  const pictureType = body[offset] ?? 0;
  offset += 1;
  const descriptionEnd = textEnd(body, offset, encoding);
  if (descriptionEnd < 0) return null;
  const data = body.subarray(descriptionEnd);
  return data.length > 0 ? { pictureType, data } : null;
}

/** Copertina da un tag ID3v2 completo (2.2, 2.3, 2.4). Preferisce la "copertina frontale". */
export function extractId3Artwork(tag: Uint8Array): EmbeddedArtwork | null {
  const total = id3TagLength(tag);
  if (total === null) return null;
  const major = tag[3] ?? 0;
  const flags = tag[5] ?? 0;
  let body = tag.subarray(10, Math.min(tag.length, total));
  if (major < 4 && (flags & 0x80) !== 0) body = deunsynchronise(body);

  let offset = 0;
  if ((flags & 0x40) !== 0 && major >= 3) {
    // Intestazione estesa: da saltare.
    const size = major === 4 ? syncsafe(body, 0) : uint32(body, 0) + 4;
    if (size <= 0 || size > body.length) return null;
    offset = size;
  }

  const v22 = major === 2;
  const headerSize = v22 ? 6 : 10;
  const candidates: Candidate[] = [];
  while (offset + headerSize <= body.length) {
    const id = ascii(body, offset, v22 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // padding o dati non validi: fine dei frame
    const size = v22
      ? uint24(body, offset + 3)
      : major === 4
        ? syncsafe(body, offset + 4)
        : uint32(body, offset + 4);
    const frameFlags = v22 ? 0 : (body[offset + 9] ?? 0);
    const start = offset + headerSize;
    const end = start + size;
    if (size <= 0 || end > body.length) break;
    if (id === (v22 ? 'PIC' : 'APIC')) {
      let frame = body.subarray(start, end);
      // ID3v2.4: compressione/cifratura non gestite; unsync e "data length" sì.
      if (major === 4) {
        if ((frameFlags & 0x0c) !== 0) {
          offset = end;
          continue;
        }
        if ((frameFlags & 0x01) !== 0) frame = frame.subarray(4);
        if ((frameFlags & 0x02) !== 0) frame = deunsynchronise(frame);
      } else if (major === 3 && ((body[offset + 9] ?? 0) & 0xc0) !== 0) {
        offset = end;
        continue;
      }
      const candidate = pictureFromApic(frame, v22);
      if (candidate) candidates.push(candidate);
    }
    offset = end;
  }
  return firstValid(candidates);
}

/** La prima immagine valida, provando prima la "copertina frontale" (tipo 3), poi le altre. */
function firstValid(candidates: Candidate[]): EmbeddedArtwork | null {
  const ordered = [
    ...candidates.filter((candidate) => candidate.pictureType === 3),
    ...candidates.filter((candidate) => candidate.pictureType !== 3),
  ];
  for (const candidate of ordered) {
    const artwork = validated(candidate.data);
    if (artwork) return artwork;
  }
  return null;
}

/** Copertina dal corpo di un blocco PICTURE dei FLAC (anche METADATA_BLOCK_PICTURE di Ogg). */
export function parseFlacPicture(block: Uint8Array): EmbeddedArtwork | null {
  const candidate = flacPictureCandidate(block);
  return candidate ? validated(candidate.data) : null;
}

function flacPictureCandidate(block: Uint8Array): Candidate | null {
  const pictureType = uint32(block, 0);
  let offset = 4; // tipo di immagine
  const mimeLength = uint32(block, offset);
  offset += 4 + mimeLength;
  if (offset + 4 > block.length) return null;
  const descriptionLength = uint32(block, offset);
  offset += 4 + descriptionLength + 16; // descrizione + larghezza, altezza, profondità, colori
  if (offset + 4 > block.length) return null;
  const dataLength = uint32(block, offset);
  offset += 4;
  if (dataLength <= 0 || offset + dataLength > block.length) return null;
  return { pictureType, data: block.subarray(offset, offset + dataLength) };
}

function validated(data: Uint8Array): EmbeddedArtwork | null {
  if (data.length === 0 || data.length > MAX_ARTWORK_TAG_BYTES) return null;
  const contentType = sniffImageType(data);
  return contentType ? { contentType, data } : null;
}

/** Byte [start, end] presi dal blocco già letto se ci stanno, altrimenti con una nuova lettura. */
async function slice(
  head: Uint8Array,
  read: ByteRangeReader,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (end < head.length) return head.subarray(start, end + 1);
  return read(start, end);
}

/**
 * Copertina incorporata in un MP3 (ID3v2) o FLAC, o null. Legge l'inizio del file e, se serve, il
 * resto del tag o del blocco immagine; mai oltre MAX_ARTWORK_TAG_BYTES.
 */
export async function readEmbeddedArtwork(read: ByteRangeReader): Promise<EmbeddedArtwork | null> {
  const head = await read(0, ARTWORK_HEAD_BYTES - 1);
  const tagLength = id3TagLength(head);
  if (tagLength !== null) {
    if (tagLength > MAX_ARTWORK_TAG_BYTES) return null;
    const tag = await slice(head, read, 0, tagLength - 1);
    if (tag.length < Math.min(tagLength, 10)) return null;
    return extractId3Artwork(tag);
  }
  if (ascii(head, 0, 4) !== 'fLaC') return null;
  // Tutti i blocchi PICTURE dei metadati (prima la copertina frontale), entro il limite di byte.
  const candidates: Candidate[] = [];
  let position = 4;
  let pictureBytes = 0;
  for (let blocks = 0; blocks < 64; blocks += 1) {
    const header = await slice(head, read, position, position + 3);
    if (header.length < 4) break;
    const last = ((header[0] ?? 0) & 0x80) !== 0;
    const type = (header[0] ?? 0) & 0x7f;
    const length = uint24(header, 1);
    if (type === 127) break;
    if (type === 6 && length > 0 && pictureBytes + length <= MAX_ARTWORK_TAG_BYTES) {
      pictureBytes += length;
      const block = await slice(head, read, position + 4, position + 3 + length);
      const candidate = block.length >= length ? flacPictureCandidate(block) : null;
      if (candidate) {
        candidates.push(candidate);
        // Una copertina frontale valida basta: inutile leggere oltre.
        if (candidate.pictureType === 3 && validated(candidate.data)) break;
      }
    }
    if (last) break;
    position += 4 + length;
    if (position > MAX_ARTWORK_TAG_BYTES) break;
  }
  return firstValid(candidates);
}
