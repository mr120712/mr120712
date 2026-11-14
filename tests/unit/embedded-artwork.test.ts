// @polsia:user-owned — copertine incorporate negli MP3 (ID3v2) e FLAC: parsing e letture minime.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type ByteRangeReader,
  extractId3Artwork,
  id3TagLength,
  MAX_ARTWORK_TAG_BYTES,
  readEmbeddedArtwork,
  sniffImageType,
} from '@/lib/music/embedded-artwork';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function bytes(...parts: Array<Uint8Array | number[] | string>): Uint8Array {
  const arrays = parts.map((part) =>
    typeof part === 'string'
      ? Uint8Array.from([...part].map((char) => char.charCodeAt(0)))
      : part instanceof Uint8Array
        ? part
        : Uint8Array.from(part),
  );
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function apic(image: Uint8Array, pictureType = 3, mime = 'image/jpeg') {
  return bytes([0], `${mime}\0`, [pictureType], 'copertina\0', image);
}

function id3(major: 2 | 3 | 4, frames: Uint8Array[], extraPadding = 16) {
  const body = bytes(...frames, new Uint8Array(extraPadding));
  return bytes('ID3', [major, 0, 0], syncsafe(body.length), body);
}

function frame(major: 3 | 4, id: string, body: Uint8Array) {
  return bytes(id, major === 4 ? syncsafe(body.length) : be32(body.length), [0, 0], body);
}

function readerFor(file: Uint8Array) {
  const calls: Array<[number, number]> = [];
  const read: ByteRangeReader = async (start, end) => {
    calls.push([start, end]);
    return file.subarray(start, Math.min(end + 1, file.length));
  };
  return { read, calls };
}

describe('copertina incorporata', () => {
  it('riconosce i formati immagine dalla firma, non dal nome', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WEBP'))).toBe('image/webp');
    expect(sniffImageType(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(bytes('<svg onload=alert(1)>'))).toBeNull();
  });

  it('ID3v2.3: APIC con copertina frontale preferita alle altre immagini', () => {
    const tag = id3(3, [
      frame(3, 'TIT2', bytes([0], 'Titolo')),
      frame(3, 'APIC', apic(PNG, 4)),
      frame(3, 'APIC', apic(JPEG, 3)),
    ]);
    expect(id3TagLength(tag)).toBe(tag.length);
    const art = extractId3Artwork(tag);
    expect(art?.contentType).toBe('image/jpeg');
    expect(Array.from(art?.data ?? [])).toEqual(Array.from(JPEG));
  });

  it('copertina frontale non valida: si usa l’altra immagine valida', () => {
    const tag = id3(3, [
      frame(3, 'APIC', apic(bytes('non è un’immagine'), 3)),
      frame(3, 'APIC', apic(PNG, 0)),
    ]);
    expect(extractId3Artwork(tag)?.contentType).toBe('image/png');
  });

  it('ID3v2.4 (dimensioni syncsafe) e descrizione UTF-16', () => {
    const body = bytes([1], 'image/png\0', [3], [0xff, 0xfe, 0x41, 0x00, 0, 0], PNG);
    const art = extractId3Artwork(id3(4, [frame(4, 'APIC', body)]));
    expect(art?.contentType).toBe('image/png');
    expect(art?.data.length).toBe(PNG.length);
  });

  it('ID3v2.2: frame PIC', () => {
    const body = bytes([0], 'JPG', [3], 'x\0', JPEG);
    const tag = id3(2, [bytes('PIC', be24(body.length), body)]);
    expect(extractId3Artwork(tag)?.contentType).toBe('image/jpeg');
  });

  it('dati che non sono un’immagine o solo un link: nessuna copertina', () => {
    expect(extractId3Artwork(id3(3, [frame(3, 'APIC', apic(bytes('<html>'), 3))]))).toBeNull();
    const link = bytes([0], '-->\0', [3], '\0', 'https://esempio.test/c.jpg');
    expect(extractId3Artwork(id3(3, [frame(3, 'APIC', link)]))).toBeNull();
    expect(extractId3Artwork(bytes('nessun tag qui'))).toBeNull();
  });

  it('MP3: legge solo il tag (64 KB iniziali), mai l’intero brano', async () => {
    const tag = id3(3, [frame(3, 'APIC', apic(JPEG))]);
    const file = bytes(tag, new Uint8Array(500_000)); // audio dopo il tag
    const { read, calls } = readerFor(file);
    const art = await readEmbeddedArtwork(read);
    expect(art?.contentType).toBe('image/jpeg');
    expect(calls).toEqual([[0, 65_535]]);
  });

  it('MP3 con tag più grande del primo blocco: una seconda lettura fino alla fine del tag', async () => {
    const big = bytes(JPEG.subarray(0, 4), new Uint8Array(100_000));
    const tag = id3(3, [frame(3, 'APIC', apic(big))]);
    const { read, calls } = readerFor(bytes(tag, new Uint8Array(1000)));
    const art = await readEmbeddedArtwork(read);
    expect(art?.data.length).toBe(big.length);
    expect(calls[1]).toEqual([0, tag.length - 1]);
  });

  it('tag dichiarato enorme: si rinuncia senza scaricarlo', async () => {
    const header = bytes('ID3', [3, 0, 0], syncsafe(MAX_ARTWORK_TAG_BYTES + 1));
    const { read, calls } = readerFor(bytes(header, new Uint8Array(100)));
    expect(await readEmbeddedArtwork(read)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('FLAC: blocco PICTURE dopo STREAMINFO', async () => {
    const picture = bytes(
      be32(3),
      be32('image/png'.length),
      'image/png',
      be32(0),
      be32(1),
      be32(1),
      be32(24),
      be32(0),
      be32(PNG.length),
      PNG,
    );
    const file = bytes(
      'fLaC',
      [0x00],
      be24(34),
      new Uint8Array(34),
      [0x80 | 6],
      be24(picture.length),
      picture,
      new Uint8Array(1000),
    );
    const { read } = readerFor(file);
    const art = await readEmbeddedArtwork(read);
    expect(art?.contentType).toBe('image/png');
  });

  it('FLAC senza immagine, o altri formati: null', async () => {
    const flac = bytes('fLaC', [0x80], be24(34), new Uint8Array(34));
    expect(await readEmbeddedArtwork(readerFor(flac).read)).toBeNull();
    expect(
      await readEmbeddedArtwork(readerFor(bytes('OggS', new Uint8Array(100))).read),
    ).toBeNull();
  });
});
