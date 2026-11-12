// @polsia:user-owned — testo e immagini letti dai tag dei file audio del dispositivo.
//
// I tag arrivano da file scelti dall'ascoltatore ma scritti da chiunque: sono input non fidato.
// Ogni stringa passa da sanitizeTagText (niente caratteri di controllo, override bidi o caratteri
// invisibili; massimo 200 caratteri) e ogni copertina da acceptArtwork (solo JPEG, PNG o WebP
// riconosciuti dai primi byte, mai dal tipo dichiarato; massimo 1 MiB). Le funzioni non lanciano
// mai eccezioni sui dati: al peggio restituiscono null.

import type { ArtworkImage, ArtworkImageType, AudioTags } from '@/lib/local-music/types';

/** Byte massimi letti in un colpo da un file locale (header e blocchi dei tag): 2 MiB. */
export const MAX_TAG_BYTES = 2 * 1024 * 1024;
export const MAX_TAG_CHARS = 200;
export const MAX_ARTWORK_BYTES = 1024 * 1024;
/** Byte decodificati al massimo per un campo di testo (bastano per 200 caratteri in ogni codifica). */
export const MAX_TEXT_BYTES = 4096;
/** Durata massima plausibile: una settimana (gli audiolibri superano le 24 ore). */
const MAX_DURATION_SECONDS = 7 * 24 * 3600;

/** Legge i byte [start, end) di un file locale (tipicamente con Blob.slice). */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

export function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

/** Intero a 32 bit big-endian senza segno; il chiamante verifica che i 4 byte esistano. */
export function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    byteAt(bytes, offset) * 0x1000000 +
    byteAt(bytes, offset + 1) * 0x10000 +
    byteAt(bytes, offset + 2) * 0x100 +
    byteAt(bytes, offset + 3)
  );
}

function isSpaceLike(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
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

function isStripped(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xffff) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

/**
 * Testo sicuro da mostrare: toglie caratteri di controllo (C0, DEL, C1), BOM, surrogati isolati,
 * override/isolati bidi e caratteri invisibili; comprime gli spazi; taglia a `max` caratteri
 * (code point). null se non resta nulla.
 */
export function sanitizeTagText(
  value: string | null | undefined,
  max: number = MAX_TAG_CHARS,
): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const char of value) {
    if (count >= max) break;
    const cp = char.codePointAt(0) ?? 0;
    if (isSpaceLike(cp)) {
      pendingSpace = count > 0;
      continue;
    }
    if (isStripped(cp)) continue;
    if (pendingSpace) {
      out += ' ';
      count += 1;
      pendingSpace = false;
      if (count >= max) break;
    }
    out += char;
    count += 1;
  }
  out = out.trimEnd();
  return out.length > 0 ? out : null;
}

// Windows-1252 per 0x80–0x9F: i tag "ISO-8859-1" reali usano spesso virgolette e trattini di
// Windows. 0 = non definito (resta un carattere C1, poi tolto da sanitizeTagText).
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0, 0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0, 0x017e, 0x0178,
];

export function decodeLatin1(bytes: Uint8Array): string {
  const limit = Math.min(bytes.length, MAX_TEXT_BYTES);
  let out = '';
  for (let i = 0; i < limit; i++) {
    const b = byteAt(bytes, i);
    const mapped = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] || b : b;
    out += String.fromCharCode(mapped);
  }
  return out;
}

export function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const limit = Math.min(bytes.length, MAX_TEXT_BYTES);
  const units: number[] = [];
  for (let i = 0; i + 1 < limit; i += 2) {
    const a = byteAt(bytes, i);
    const b = byteAt(bytes, i + 1);
    units.push(littleEndian ? a | (b << 8) : (a << 8) | b);
  }
  // I surrogati isolati restano qui e li toglie sanitizeTagText.
  return String.fromCharCode(...units);
}

/** UTF-16 con BOM opzionale: FF FE little-endian, FE FF big-endian, altrimenti `fallbackLE`. */
export function decodeUtf16WithBom(bytes: Uint8Array, fallbackLittleEndian: boolean): string {
  const b0 = byteAt(bytes, 0);
  const b1 = byteAt(bytes, 1);
  if (bytes.length >= 2 && b0 === 0xff && b1 === 0xfe) return decodeUtf16(bytes.subarray(2), true);
  if (bytes.length >= 2 && b0 === 0xfe && b1 === 0xff) return decodeUtf16(bytes.subarray(2), false);
  return decodeUtf16(bytes, fallbackLittleEndian);
}

export function decodeUtf8(bytes: Uint8Array): string {
  const capped = bytes.subarray(0, MAX_TEXT_BYTES);
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(capped);
  } catch {
    // Motore senza TextDecoder utilizzabile: meglio Latin-1 che niente.
  }
  return decodeLatin1(capped);
}

/** Divide sui terminatori NUL (doppio NUL allineato per l'UTF-16). */
function splitTerminated(bytes: Uint8Array, wide: boolean): Uint8Array[] {
  const parts: Uint8Array[] = [];
  const step = wide ? 2 : 1;
  let start = 0;
  for (let i = 0; i + step <= bytes.length; i += step) {
    if (byteAt(bytes, i) === 0 && (!wide || byteAt(bytes, i + 1) === 0)) {
      parts.push(bytes.subarray(start, i));
      start = i + step;
    }
  }
  if (start < bytes.length) parts.push(bytes.subarray(start));
  return parts;
}

/**
 * Valori di un frame di testo ID3 (senza il byte di codifica): 0 ISO-8859-1, 1 UTF-16 con BOM,
 * 2 UTF-16BE, 3 UTF-8. Più valori separati da NUL (ID3v2.4) diventano più stringhe.
 */
export function decodeId3Text(data: Uint8Array, encoding: number): string[] {
  if (encoding < 0 || encoding > 3) return [];
  const wide = encoding === 1 || encoding === 2;
  const values: string[] = [];
  for (const part of splitTerminated(data.subarray(0, MAX_TEXT_BYTES), wide)) {
    let text: string;
    if (encoding === 0) text = decodeLatin1(part);
    else if (encoding === 3) text = decodeUtf8(part);
    else text = decodeUtf16WithBom(part, encoding === 1);
    const clean = sanitizeTagText(text);
    if (clean && !values.includes(clean)) values.push(clean);
    if (values.length >= 16) break;
  }
  return values;
}

/** Testo di un box 'data' iTunes: tipo 1 UTF-8, 2 UTF-16BE; gli altri provati come UTF-8. */
export function decodeMp4Text(value: Uint8Array, typeCode: number): string | null {
  const text = typeCode === 2 ? decodeUtf16WithBom(value, false) : decodeUtf8(value);
  return sanitizeTagText(text.split('\u0000')[0]);
}

export function sniffImageType(bytes: Uint8Array): ArtworkImageType | null {
  const b = (i: number) => byteAt(bytes, i);
  if (bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    b(0) === 0x89 &&
    b(1) === 0x50 &&
    b(2) === 0x4e &&
    b(3) === 0x47 &&
    b(4) === 0x0d &&
    b(5) === 0x0a &&
    b(6) === 0x1a &&
    b(7) === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Copertina accettabile (JPEG/PNG/WebP dai primi byte, 12 B–1 MiB) copiata in un buffer suo. */
export function acceptArtwork(bytes: Uint8Array): ArtworkImage | null {
  if (bytes.length < 12 || bytes.length > MAX_ARTWORK_BYTES) return null;
  const mimeType = sniffImageType(bytes);
  return mimeType ? { mimeType, bytes: bytes.slice() } : null;
}

export function plausibleDuration(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DURATION_SECONDS) return null;
  return Math.round(seconds * 1000) / 1000;
}

/** Campi raccolti durante la lettura, prima di scegliere i valori finali. */
export type TagDraft = {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  artwork?: ArtworkImage;
  artworkIsFront?: boolean;
  durationSeconds?: number;
};

export function finalizeTags(draft: TagDraft): AudioTags {
  return {
    title: draft.title ?? null,
    artist: draft.artist ?? draft.albumArtist ?? null,
    album: draft.album ?? null,
    artwork: draft.artwork ?? null,
    durationSeconds: draft.durationSeconds ?? null,
  };
}

/** Completa i campi mancanti di `primary` con quelli di `fallback`. */
export function fillMissingTags(primary: AudioTags, fallback: AudioTags): AudioTags {
  return {
    title: primary.title ?? fallback.title,
    artist: primary.artist ?? fallback.artist,
    album: primary.album ?? fallback.album,
    artwork: primary.artwork ?? fallback.artwork,
    durationSeconds: primary.durationSeconds ?? fallback.durationSeconds,
  };
}
