// @polsia:user-owned — copia offline dei "brani in evidenza" SENZA il testo incorporato nel file.
//
// Il testo di una canzone è un'opera separata dalla registrazione: Solco lo mostra solo per i brani
// con "testo": true in diritti.json. Una copia salvata in «La tua musica» però è un file sul
// dispositivo, e la Libreria sa leggere il testo incorporato nei file (src/lib/local-music/lyrics:
// USLT/SYLT/TXXX degli MP3, ©lyr degli M4A, LYRICS dei FLAC). Perciò, quando la voce del brano non
// dichiara "testo": true, la rotta di download toglie quei tag dai byte PRIMA di inviarli:
//
// - MP3: il tag ID3v2 iniziale si toglie per intero (anche più tag di fila): i dati del brano
//   (titolo, artista, attribuzione) viaggiano comunque nell'header dei metadati della rotta;
// - FLAC: i blocchi VORBIS_COMMENT diventano PADDING azzerato (stessa lunghezza, audio intatto);
// - M4A/MP4: le voci '©lyr' di moov/udta/meta/ilst e moov/meta/ilst diventano box 'free' azzerati
//   (stessa lunghezza: gli offset dei campioni non cambiano).
//
// La verifica usa LO STESSO lettore della Libreria (readLocalLyrics) sui byte finali: se dopo la
// pulizia trova ancora un testo, o se il file non si sa pulire, il risultato è { ok: false } e la
// rotta non invia nulla (quel brano resta solo in streaming). Nel dubbio si esclude.
import 'server-only';
import { readId3v2Header } from '@/lib/local-music/id3';
import { readLocalLyrics } from '@/lib/local-music/lyrics';
import { parseBoxHeader } from '@/lib/local-music/mp4';

/** Tag ID3v2 di fila tolti al massimo dall'inizio del file. */
const MAX_ID3_TAGS = 8;
/** Blocchi di metadati FLAC esaminati al massimo (come il lettore della Libreria). */
const MAX_FLAC_BLOCKS = 64;
/** Box esaminati al massimo per livello. */
const MAX_BOXES = 1024;
const FREE = [0x66, 0x72, 0x65, 0x65];

export type LyricsFreeAudio = { ok: true; bytes: Uint8Array } | { ok: false };

/** True se il lettore della Libreria trova un testo in questi byte. */
async function hasEmbeddedLyrics(bytes: Uint8Array): Promise<boolean> {
  return (await readLocalLyrics(new Blob([new Uint8Array(bytes)]))) !== null;
}

function startsWith(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (at + ascii.length > bytes.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[at + index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

/** Blocchi VORBIS_COMMENT → PADDING azzerato, sul posto. */
function blankFlacComments(bytes: Uint8Array): void {
  let position = 4;
  for (let blocks = 0; blocks < MAX_FLAC_BLOCKS && position + 4 <= bytes.length; blocks += 1) {
    const flags = bytes[position] ?? 0;
    const type = flags & 0x7f;
    const length =
      (bytes[position + 1] ?? 0) * 0x10000 +
      (bytes[position + 2] ?? 0) * 0x100 +
      (bytes[position + 3] ?? 0);
    if (type === 127) return;
    if (type === 4) {
      bytes[position] = (flags & 0x80) | 1;
      bytes.fill(0, position + 4, Math.min(position + 4 + length, bytes.length));
    }
    if (flags & 0x80) return;
    position += 4 + length;
  }
}

function* childBoxes(bytes: Uint8Array, start: number, end: number) {
  const limit = Math.min(end, bytes.length);
  let position = start;
  for (let count = 0; count < MAX_BOXES && position + 8 <= limit; count += 1) {
    const box = parseBoxHeader(bytes.subarray(position, position + 16), position, end);
    if (!box) return;
    yield box;
    position = box.end;
  }
}

/** Le voci '©lyr' di un box 'meta' → 'free' azzerati, sul posto. */
function blankMetaLyrics(
  bytes: Uint8Array,
  meta: { start: number; headerSize: number; end: number },
) {
  const content = meta.start + meta.headerSize;
  // 'meta' ISO ha 4 byte di versione/flag prima dei figli; quello QuickTime no (come la Libreria).
  const first = startsWith(bytes, content + 4, 'hdlr') ? content : content + 4;
  for (const child of childBoxes(bytes, first, meta.end)) {
    if (child.type !== 'ilst') continue;
    for (const item of childBoxes(bytes, child.start + child.headerSize, child.end)) {
      if (item.type !== '©lyr') continue;
      bytes.set(FREE, item.start + 4);
      bytes.fill(0, item.start + item.headerSize, Math.min(item.end, bytes.length));
    }
  }
}

/** Le voci '©lyr' di moov/udta/meta e moov/meta → 'free' azzerati, sul posto. */
function blankMp4Lyrics(bytes: Uint8Array): void {
  for (const top of childBoxes(bytes, 0, bytes.length)) {
    if (top.type !== 'moov') continue;
    for (const child of childBoxes(bytes, top.start + top.headerSize, top.end)) {
      if (child.type === 'meta') blankMetaLyrics(bytes, child);
      if (child.type !== 'udta') continue;
      for (const inner of childBoxes(bytes, child.start + child.headerSize, child.end)) {
        if (inner.type === 'meta') blankMetaLyrics(bytes, inner);
      }
    }
  }
}

/** Una copia dei byte senza i tag del testo (vedi sopra), o null se non resta audio. */
export function stripEmbeddedLyrics(input: Uint8Array): Uint8Array | null {
  let start = 0;
  for (let count = 0; count < MAX_ID3_TAGS; count += 1) {
    const header = readId3v2Header(input.subarray(start, start + 10));
    if (!header) break;
    start += header.totalSize;
    // Un tag che dichiara di coprire tutto il file: nessun audio da salvare.
    if (start >= input.length) return null;
  }
  const bytes = input.slice(start);
  if (startsWith(bytes, 0, 'fLaC')) blankFlacComments(bytes);
  else if (startsWith(bytes, 4, 'ftyp')) blankMp4Lyrics(bytes);
  return bytes;
}

/**
 * I byte da inviare per la copia offline di un brano SENZA "testo": true: gli stessi se il lettore
 * della Libreria non vi trova un testo, altrimenti una copia ripulita e riverificata; { ok: false }
 * se il testo non si riesce a togliere (il brano resta solo in streaming). Mai throw.
 */
export async function withoutEmbeddedLyrics(bytes: Uint8Array): Promise<LyricsFreeAudio> {
  try {
    if (!(await hasEmbeddedLyrics(bytes))) return { ok: true, bytes };
    const stripped = stripEmbeddedLyrics(bytes);
    if (!stripped || stripped.length === 0 || (await hasEmbeddedLyrics(stripped))) {
      return { ok: false };
    }
    return { ok: true, bytes: stripped };
  } catch {
    return { ok: false };
  }
}
