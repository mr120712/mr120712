// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  parseId3v1,
  parseId3v2,
  readId3v2Header,
  removeUnsynchronisation,
} from '@/lib/local-music/id3';
import { parseMp4Tags } from '@/lib/local-music/mp4';
import {
  acceptArtwork,
  MAX_ARTWORK_BYTES,
  MAX_TAG_BYTES,
  sanitizeTagText,
  sniffImageType,
} from '@/lib/local-music/tag-utils';
import { readAudioTags, tagsFromFileName } from '@/lib/local-music/tags';
import type { AudioTags } from '@/lib/local-music/types';

// --- Costruttori di byte -------------------------------------------------------------------

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u24 = (n: number) => [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const syncsafe = (n: number) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const utf16le = (s: string) => units(s).flatMap((c) => [c & 255, c >>> 8]);
const utf16be = (s: string) => units(s).flatMap((c) => [c >>> 8, c & 255]);
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const zeros = (n: number) => new Array<number>(n).fill(0);

const text = {
  latin1: (s: string) => [0, ...ascii(s)],
  utf16le: (s: string) => [1, 0xff, 0xfe, ...utf16le(s)],
  utf16beBom: (s: string) => [1, 0xfe, 0xff, ...utf16be(s)],
  utf16be: (s: string) => [2, ...utf16be(s)],
  utf8: (s: string) => [3, ...utf8(s)],
};

const JPEG = [
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  ...ascii('JFIF'),
  0,
  1,
  2,
  0xff,
  0x00,
  0xff,
  0xd9,
];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR')];
const WEBP = [...ascii('RIFF'), 20, 0, 0, 0, ...ascii('WEBPVP8 '), 1, 2, 3, 4];
const GIF = [...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0];

function apic(
  image: number[],
  { type = 3, mime = 'image/jpeg', encoding = 0, description = 'cover' } = {},
): number[] {
  const desc =
    encoding === 1
      ? [0xff, 0xfe, ...utf16le(description), 0, 0]
      : encoding === 2
        ? [...utf16be(description), 0, 0]
        : [...ascii(description), 0];
  return [encoding, ...ascii(mime), 0, type, ...desc, ...image];
}

const pic22 = (image: number[], format = 'JPG', type = 3) => [
  0,
  ...ascii(format),
  type,
  ...ascii('d'),
  0,
  ...image,
];

const frame22 = (id: string, data: number[]) => [...ascii(id), ...u24(data.length), ...data];
const frame23 = (id: string, data: number[], flags = [0, 0]) => [
  ...ascii(id),
  ...u32(data.length),
  ...flags,
  ...data,
];
const frame24 = (id: string, data: number[], flags = [0, 0]) => [
  ...ascii(id),
  ...syncsafe(data.length),
  ...flags,
  ...data,
];
const id3 = (major: number, body: number[], flags = 0) =>
  new Uint8Array([...ascii('ID3'), major, 0, flags, ...syncsafe(body.length), ...body]);
const unsync = (bytes: number[]) => bytes.flatMap((b) => (b === 0xff ? [b, 0] : [b]));

function id3v1(title: string, artist: string, album: string): number[] {
  const field = (s: string, n: number) => [...ascii(s).slice(0, n), ...zeros(n)].slice(0, n);
  return [
    ...ascii('TAG'),
    ...field(title, 30),
    ...field(artist, 30),
    ...field(album, 30),
    ...ascii('2024'),
    ...zeros(30),
    0,
  ];
}

const box = (type: string, payload: number[]) => [
  ...u32(8 + payload.length),
  ...ascii(type),
  ...payload,
];
const box64 = (type: string, payload: number[]) => [
  ...u32(1),
  ...ascii(type),
  ...u32(0),
  ...u32(16 + payload.length),
  ...payload,
];
const dataBox = (typeCode: number, value: number[]) =>
  box('data', [...u32(typeCode), 0, 0, 0, 0, ...value]);
const hdlr = box('hdlr', [...zeros(8), ...ascii('mdirappl'), ...zeros(9)]);
const ftyp = box('ftyp', [...ascii('M4A '), 0, 0, 0, 0, ...ascii('M4A isom')]);
const mvhd0 = (timescale: number, duration: number) =>
  box('mvhd', [
    0,
    0,
    0,
    0,
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(duration),
    ...zeros(80),
  ]);
const mvhd1 = (timescale: number, hi: number, lo: number) =>
  box('mvhd', [1, 0, 0, 0, ...zeros(16), ...u32(timescale), ...u32(hi), ...u32(lo), ...zeros(80)]);

function ilst(items: Record<string, number[]>): number[] {
  return box(
    'ilst',
    Object.entries(items).flatMap(([type, data]) => box(type, data)),
  );
}

function m4a({
  items,
  moovExtra = [],
  quickTimeMeta = false,
  mdatBytes = 32,
  moovFirst = true,
}: {
  items: Record<string, number[]>;
  moovExtra?: number[];
  quickTimeMeta?: boolean;
  mdatBytes?: number;
  moovFirst?: boolean;
}): Uint8Array {
  const meta = box('meta', [...(quickTimeMeta ? [] : [0, 0, 0, 0]), ...hdlr, ...ilst(items)]);
  const trak = box('trak', box('tkhd', zeros(84)));
  const moov = box('moov', [
    ...mvhd0(44100, 44100 * 215),
    ...trak,
    ...moovExtra,
    ...box('udta', meta),
  ]);
  const mdat = box('mdat', zeros(mdatBytes));
  return new Uint8Array(moovFirst ? [...ftyp, ...moov, ...mdat] : [...ftyp, ...mdat, ...moov]);
}

const STANDARD_ITEMS = {
  '©nam': dataBox(1, utf8('Titolo')),
  '©ART': dataBox(1, utf8('Artista')),
  '©alb': dataBox(1, utf8('Album')),
  covr: dataBox(13, JPEG),
};

/** PRNG deterministico per i test di input casuale. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectSafe(tags: AudioTags) {
  for (const value of [tags.title, tags.artist, tags.album]) {
    if (value === null) continue;
    expect(Array.from(value).length).toBeLessThanOrEqual(200);
    for (const char of value) {
      const cp = char.codePointAt(0) ?? 0;
      expect(cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f)).toBe(true);
    }
  }
  if (tags.artwork) {
    expect(tags.artwork.bytes.length).toBeLessThanOrEqual(MAX_ARTWORK_BYTES);
    expect(['image/jpeg', 'image/png', 'image/webp']).toContain(tags.artwork.mimeType);
  }
}

/** Blob che registra ogni slice letto (per verificare che non si legga mai tutto il file). */
function trackedBlob(bytes: Uint8Array) {
  const blob = new Blob([bytes]);
  const reads: Array<[number, number]> = [];
  const original = blob.slice.bind(blob);
  vi.spyOn(blob, 'slice').mockImplementation((start?: number, end?: number, type?: string) => {
    reads.push([start ?? 0, end ?? bytes.length]);
    return original(start, end, type);
  });
  return { blob, reads };
}

// --- ID3v2 ----------------------------------------------------------------------------------

describe('ID3v2', () => {
  it('reads an ID3v2.3 tag with Latin-1 text and a front cover', () => {
    const tag = id3(3, [
      ...frame23('TIT2', text.latin1('Caffè')),
      ...frame23('TPE1', text.latin1('Artista')),
      ...frame23('TALB', text.latin1('Album')),
      ...frame23('APIC', apic(JPEG)),
      ...zeros(16), // padding
    ]);
    expect(parseId3v2(tag)).toEqual({
      title: 'Caffè',
      artist: 'Artista',
      album: 'Album',
      artwork: { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) },
      durationSeconds: null,
    });
  });

  it('maps the Windows-1252 range of "ISO-8859-1" text', () => {
    const tag = id3(3, frame23('TIT2', [0, ...ascii('Don'), 0x92, ...ascii('t stop'), 0x85]));
    expect(parseId3v2(tag).title).toBe('Don’t stop…');
  });

  it('reads ID3v2.4 UTF-8 text, syncsafe frame sizes above 127 and multiple artists', () => {
    const long = 'x'.repeat(150);
    const tag = id3(4, [
      ...frame24('TIT2', text.utf8(long)),
      ...frame24('TPE1', [3, ...utf8('Uno'), 0, ...utf8('Due'), 0, ...utf8('Uno')]),
      ...frame24('TALB', text.utf8('Àlbum ♫')),
    ]);
    const tags = parseId3v2(tag);
    expect(tags.title).toBe(long);
    expect(tags.artist).toBe('Uno, Due');
    expect(tags.album).toBe('Àlbum ♫');
  });

  it('reads an ID3v2.2 tag (TT2/TP1/TAL/PIC)', () => {
    const tag = id3(2, [
      ...frame22('TT2', text.latin1('Vecchio')),
      ...frame22('TP1', text.latin1('Autore')),
      ...frame22('TAL', text.latin1('Raccolta')),
      ...frame22('PIC', pic22(PNG, 'PNG')),
    ]);
    expect(parseId3v2(tag)).toEqual({
      title: 'Vecchio',
      artist: 'Autore',
      album: 'Raccolta',
      artwork: { mimeType: 'image/png', bytes: new Uint8Array(PNG) },
      durationSeconds: null,
    });
  });

  it('ignores a v2.2 tag with the compression flag', () => {
    expect(parseId3v2(id3(2, frame22('TT2', text.latin1('X')), 0x40)).title).toBeNull();
  });

  it('decodes UTF-16 with either BOM and UTF-16BE, keeping surrogate pairs', () => {
    const tag = id3(4, [
      ...frame24('TIT2', text.utf16le('Città 🎵')),
      ...frame24('TPE1', text.utf16beBom('Édith')),
      ...frame24('TALB', text.utf16be('Bianco ♪')),
    ]);
    expect(parseId3v2(tag)).toMatchObject({
      title: 'Città 🎵',
      artist: 'Édith',
      album: 'Bianco ♪',
    });
  });

  it('assumes little-endian for UTF-16 without BOM and decodes multi-value UTF-16', () => {
    const tag = id3(3, [
      ...frame23('TIT2', [1, ...utf16le('Senza BOM')]),
      ...frame23('TPE1', [1, 0xff, 0xfe, ...utf16le('A'), 0, 0, 0xfe, 0xff, ...utf16be('B')]),
    ]);
    expect(parseId3v2(tag)).toMatchObject({ title: 'Senza BOM', artist: 'A, B' });
  });

  it('removes tag-level unsynchronisation (v2.3)', () => {
    const frames = [...frame23('TIT2', text.latin1('Sync')), ...frame23('APIC', apic(JPEG))];
    const tag = id3(3, unsync(frames), 0x80);
    expect(tag.length).toBeGreaterThan(10 + frames.length);
    const tags = parseId3v2(tag);
    expect(tags.title).toBe('Sync');
    expect(tags.artwork?.bytes).toEqual(new Uint8Array(JPEG));
  });

  it('removes per-frame unsynchronisation with a data length indicator (v2.4)', () => {
    const picture = apic(JPEG);
    const stored = [...syncsafe(picture.length), ...unsync(picture)];
    const tag = id3(4, [
      ...frame24('TIT2', text.latin1('Frame')),
      ...frame24('APIC', stored, [0, 0x03]),
    ]);
    expect(parseId3v2(tag).artwork?.bytes).toEqual(new Uint8Array(JPEG));
  });

  it('applies the v2.4 header unsynchronisation flag to every frame', () => {
    const picture = apic(JPEG);
    const tag = id3(4, frame24('APIC', unsync(picture)), 0x80);
    expect(parseId3v2(tag).artwork?.bytes).toEqual(new Uint8Array(JPEG));
  });

  it('skips the grouping identity byte (v2.3 and v2.4)', () => {
    expect(
      parseId3v2(id3(3, frame23('TIT2', [0x07, ...text.latin1('Gruppo')], [0, 0x20]))).title,
    ).toBe('Gruppo');
    expect(
      parseId3v2(id3(4, frame24('TIT2', [0x07, ...text.latin1('Gruppo')], [0, 0x40]))).title,
    ).toBe('Gruppo');
  });

  it('skips the extended header (v2.3 and v2.4)', () => {
    const v23 = id3(3, [...u32(6), 0, 0, ...u32(0), ...frame23('TIT2', text.latin1('Ext3'))], 0x40);
    expect(parseId3v2(v23).title).toBe('Ext3');
    const v24 = id3(4, [...syncsafe(6), 1, 0, ...frame24('TIT2', text.latin1('Ext4'))], 0x40);
    expect(parseId3v2(v24).title).toBe('Ext4');
  });

  it('rejects an extended header larger than the tag', () => {
    const tag = id3(3, [...u32(0x7fffffff), ...frame23('TIT2', text.latin1('X'))], 0x40);
    expect(parseId3v2(tag).title).toBeNull();
  });

  it('counts the v2.4 footer in the total tag size', () => {
    const body = frame24('TIT2', text.latin1('Footer'));
    const tag = id3(4, body, 0x10);
    expect(readId3v2Header(tag)).toEqual({
      major: 4,
      flags: 0x10,
      size: body.length,
      totalSize: 10 + body.length + 10,
    });
    expect(
      parseId3v2(new Uint8Array([...tag, ...ascii('3DI'), 4, 0, 0x10, ...syncsafe(body.length)]))
        .title,
    ).toBe('Footer');
  });

  it('accepts the non-syncsafe v2.4 frame sizes written by old iTunes', () => {
    const highBit = 'h'.repeat(199); // 200 byte: 0x000000C8, non syncsafe
    const ambiguous = 'z'.repeat(255); // 256 byte: 00 00 01 00 (syncsafe = 128)
    const raw = (id: string, data: number[]) => [...ascii(id), ...u32(data.length), 0, 0, ...data];
    expect(
      parseId3v2(
        id3(4, [...raw('TIT2', text.latin1(highBit)), ...raw('TPE1', text.latin1('Dopo'))]),
      ),
    ).toMatchObject({ title: highBit, artist: 'Dopo' });
    expect(
      parseId3v2(
        id3(4, [...raw('TIT2', text.latin1(ambiguous)), ...raw('TPE1', text.latin1('Dopo'))]),
      ),
    ).toMatchObject({ title: 'z'.repeat(200), artist: 'Dopo' });
  });

  it('does not take a 0x00 inside UTF-16 text or a picture for the end of an iTunes frame', () => {
    const raw = (id: string, data: number[]) => [...ascii(id), ...u32(data.length), 0, 0, ...data];
    // 256 byte (00 00 01 00, syncsafe = 128): al byte 128 c'è lo 0x00 alto di un carattere UTF-16LE.
    const long = 'abcdefghijklm'.repeat(10).slice(0, 126);
    const title = [...text.utf16le(long), 0];
    expect([title.length, title[128]]).toEqual([256, 0]);
    expect(
      parseId3v2(id3(4, [...raw('TIT2', title), ...raw('TPE1', text.latin1('Dopo'))])),
    ).toMatchObject({ title: long, artist: 'Dopo' });

    // APIC di 0x12345 byte (syncsafe = 20933) con un solo 0x00 proprio a quell'offset.
    const size = 0x12345;
    const picture = apic([...JPEG, ...new Array<number>(size).fill(0xaa)], { description: '' });
    picture.length = size;
    picture[20933] = 0;
    const tags = parseId3v2(id3(4, [...raw('APIC', picture), ...raw('TIT2', text.latin1('Dopo'))]));
    expect(tags.title).toBe('Dopo');
    expect(tags.artwork?.bytes.length).toBe(size - 14);

    // Un frame syncsafe vero seguito da padding resta syncsafe (raw = 0x148 cadrebbe nel padding).
    const proper = frame24('TIT2', text.latin1('p'.repeat(199)));
    expect(proper.slice(4, 8)).toEqual([0, 0, 1, 0x48]);
    expect(parseId3v2(id3(4, [...proper, ...zeros(400)])).title).toBe('p'.repeat(199));
  });

  it('skips compressed or encrypted frames and keeps reading', () => {
    const tag = id3(3, [
      ...frame23('TIT2', [...u32(100), 0x78, 0x9c, 1, 2], [0, 0x80]),
      ...frame23('TPE1', [0x01, 1, 2, 3], [0, 0x40]),
      ...frame23('TIT2', text.latin1('In chiaro')),
      ...frame23('TPE1', text.latin1('Visibile')),
    ]);
    expect(parseId3v2(tag)).toMatchObject({ title: 'In chiaro', artist: 'Visibile' });
    const v24 = id3(4, [
      ...frame24('TIT2', [1, 2, 3], [0, 0x08]),
      ...frame24('TIT2', [1, 2, 3], [0, 0x04]),
      ...frame24('TIT2', text.latin1('Ok')),
    ]);
    expect(parseId3v2(v24).title).toBe('Ok');
  });

  it('prefers the front cover and falls back to the album artist', () => {
    const tag = id3(3, [
      ...frame23('APIC', apic(PNG, { type: 0, mime: 'image/png' })),
      ...frame23('APIC', apic(JPEG, { type: 3, encoding: 1, description: 'Fronte' })),
      ...frame23('APIC', apic(WEBP, { type: 4, mime: 'image/webp' })),
      ...frame23('TPE2', text.latin1('Artista album')),
    ]);
    const tags = parseId3v2(tag);
    expect(tags.artwork).toEqual({ mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) });
    expect(tags.artist).toBe('Artista album');
  });

  it('keeps the first picture when none is a front cover; UTF-16BE descriptions too', () => {
    const tag = id3(4, [
      ...frame24(
        'APIC',
        apic(WEBP, { type: 0, mime: 'image/webp', encoding: 2, description: 'x' }),
      ),
      ...frame24('APIC', apic(PNG, { type: 5, mime: 'image/png' })),
    ]);
    expect(parseId3v2(tag).artwork?.mimeType).toBe('image/webp');
  });

  it('accepts artwork only by its signature, and at most 1 MiB', () => {
    const gif = parseId3v2(id3(3, frame23('APIC', apic(GIF, { mime: 'image/gif' }))));
    expect(gif.artwork).toBeNull();
    const lying = parseId3v2(id3(3, frame23('APIC', apic(PNG, { mime: 'image/jpeg' }))));
    expect(lying.artwork?.mimeType).toBe('image/png');
    const link = parseId3v2(
      id3(3, frame23('APIC', apic(ascii('https://x.test/a.jpg'), { mime: '-->' }))),
    );
    expect(link.artwork).toBeNull();
    const huge = [...JPEG, ...zeros(MAX_ARTWORK_BYTES)];
    const big = parseId3v2(
      id3(3, [...frame23('APIC', apic(huge)), ...frame23('TIT2', text.latin1('Dopo'))]),
    );
    expect(big.artwork).toBeNull();
    expect(big.title).toBe('Dopo');
  });

  it('keeps what it read when the tag is truncated', () => {
    const full = id3(3, [
      ...frame23('TIT2', text.latin1('Primo')),
      ...frame23('TPE1', text.latin1('Secondo frame tagliato')),
    ]);
    const cut = full.subarray(0, full.length - 5);
    expect(parseId3v2(cut)).toMatchObject({ title: 'Primo', artist: null });
  });

  it('survives huge declared sizes', () => {
    const tag = new Uint8Array([
      ...ascii('ID3'),
      3,
      0,
      0,
      0x7f,
      0x7f,
      0x7f,
      0x7f,
      ...ascii('TIT2'),
      0xff,
      0xff,
      0xff,
      0xff,
      0,
      0,
      0,
      ...ascii('abc'),
    ]);
    expect(readId3v2Header(tag)?.size).toBe(0x0fffffff);
    expect(parseId3v2(tag).title).toBeNull();
    const v24 = id3(4, [...ascii('TIT2'), 0x7f, 0x7f, 0x7f, 0x7f, 0, 0, 1, 2]);
    expect(parseId3v2(v24).title).toBeNull();
  });

  it('stops at padding, garbage frame ids and empty frames without throwing', () => {
    const tag = id3(3, [
      ...frame23('TIT2', []),
      ...frame23('TIT2', text.latin1('Dopo il vuoto')),
      ...ascii('t!t2'),
      ...frame23('TPE1', text.latin1('Mai letto')),
    ]);
    expect(parseId3v2(tag)).toMatchObject({ title: 'Dopo il vuoto', artist: null });
  });

  it('rejects invalid headers', () => {
    expect(readId3v2Header(new Uint8Array([...ascii('ID3'), 5, 0, 0, 0, 0, 0, 1]))).toBeNull();
    expect(readId3v2Header(new Uint8Array([...ascii('ID3'), 3, 0xff, 0, 0, 0, 0, 1]))).toBeNull();
    expect(readId3v2Header(new Uint8Array([...ascii('ID3'), 3, 0, 0, 0x80, 0, 0, 1]))).toBeNull();
    expect(readId3v2Header(new Uint8Array([...ascii('ID3'), 3]))).toBeNull();
    expect(
      readId3v2Header(new Uint8Array(ascii('XYZ\u0003\u0000\u0000\u0000\u0000\u0000\u0001'))),
    ).toBeNull();
  });

  it('sanitises control characters, bidi overrides and caps strings at 200 characters', () => {
    const tag = id3(4, [
      ...frame24('TIT2', text.utf8(`A\u0000B`)),
      ...frame24('TPE1', text.utf8('‮evil‬\u0007​  name\t\n')),
      ...frame24('TALB', text.utf8('🎵'.repeat(300))),
    ]);
    const tags = parseId3v2(tag);
    expect(tags.title).toBe('A');
    expect(tags.artist).toBe('evil name');
    expect(Array.from(tags.album ?? '')).toHaveLength(200);
  });

  it('never throws on random input', () => {
    const random = mulberry32(42);
    for (let i = 0; i < 400; i++) {
      const length = Math.floor(random() * 600);
      const bytes = new Uint8Array(length + 10);
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(random() * 256);
      bytes.set([0x49, 0x44, 0x33, 2 + (i % 3), 0, Math.floor(random() * 256)], 0);
      bytes.set(syncsafe(Math.floor(random() * 2000)), 6);
      // Frame plausibili seguiti da spazzatura.
      if (i % 2 === 0 && length > 20) bytes.set(i % 3 === 0 ? ascii('TT2') : ascii('TIT2'), 10);
      expectSafe(parseId3v2(bytes));
    }
  });

  it('removes unsynchronisation bytes only after 0xFF', () => {
    expect(
      Array.from(removeUnsynchronisation(new Uint8Array([0xff, 0, 0xe0, 0, 0xff, 0, 0, 0xff]))),
    ).toEqual([0xff, 0xe0, 0, 0xff, 0, 0xff]);
  });
});

describe('ID3v1', () => {
  it('reads the last 128 bytes', () => {
    const bytes = new Uint8Array([...zeros(50), ...id3v1('Titolo v1', 'Artista v1', 'Album v1')]);
    expect(parseId3v1(bytes)).toMatchObject({
      title: 'Titolo v1',
      artist: 'Artista v1',
      album: 'Album v1',
    });
  });

  it('returns empty tags without the TAG marker or when too short', () => {
    expect(parseId3v1(new Uint8Array(128)).title).toBeNull();
    expect(parseId3v1(new Uint8Array(ascii('TAG'))).title).toBeNull();
  });
});

// --- MP4 / M4A ------------------------------------------------------------------------------

describe('MP4 ilst', () => {
  it('reads ©nam/©ART/©alb/covr and the mvhd duration', () => {
    expect(parseMp4Tags(m4a({ items: STANDARD_ITEMS }))).toEqual({
      title: 'Titolo',
      artist: 'Artista',
      album: 'Album',
      artwork: { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) },
      durationSeconds: 215,
    });
  });

  it('reads QuickTime-style meta boxes (no version/flags)', () => {
    expect(parseMp4Tags(m4a({ items: STANDARD_ITEMS, quickTimeMeta: true })).title).toBe('Titolo');
  });

  it('decodes UTF-16BE text and falls back to aART for the artist', () => {
    const tags = parseMp4Tags(
      m4a({ items: { '©nam': dataBox(2, utf16be('Canzone ♫')), aART: dataBox(1, utf8('Band')) } }),
    );
    expect(tags).toMatchObject({ title: 'Canzone ♫', artist: 'Band', album: null, artwork: null });
  });

  it('accepts covr by signature only (PNG yes, GIF and >1 MiB no)', () => {
    expect(parseMp4Tags(m4a({ items: { covr: dataBox(14, PNG) } })).artwork?.mimeType).toBe(
      'image/png',
    );
    expect(parseMp4Tags(m4a({ items: { covr: dataBox(0, WEBP) } })).artwork?.mimeType).toBe(
      'image/webp',
    );
    expect(parseMp4Tags(m4a({ items: { covr: dataBox(13, GIF) } })).artwork).toBeNull();
    const big = [...JPEG, ...zeros(MAX_ARTWORK_BYTES)];
    expect(parseMp4Tags(m4a({ items: { covr: dataBox(13, big) } })).artwork).toBeNull();
  });

  it('takes the first acceptable covr data box', () => {
    const covr = [...dataBox(13, GIF), ...dataBox(14, PNG), ...dataBox(13, JPEG)];
    expect(parseMp4Tags(m4a({ items: { covr } })).artwork?.mimeType).toBe('image/png');
  });

  it('handles 64-bit and to-end-of-file box sizes', () => {
    const meta = box('meta', [
      0,
      0,
      0,
      0,
      ...hdlr,
      ...ilst({ '©nam': dataBox(1, utf8('Grande')) }),
    ]);
    const moov = box64('moov', [...mvhd1(1000, 0, 90_500), ...box('udta', meta)]);
    const toEnd = [...u32(0), ...ascii('mdat'), ...zeros(64)];
    const tags = parseMp4Tags(
      new Uint8Array([...ftyp, ...box64('free', zeros(4)), ...moov, ...toEnd]),
    );
    expect(tags).toMatchObject({ title: 'Grande', durationSeconds: 90.5 });
  });

  it('ignores an unknown mvhd duration', () => {
    const file = new Uint8Array([...ftyp, ...box('moov', mvhd0(1000, 0xffffffff))]);
    expect(parseMp4Tags(file).durationSeconds).toBeNull();
    const zeroScale = new Uint8Array([...ftyp, ...box('moov', mvhd0(0, 1000))]);
    expect(parseMp4Tags(zeroScale).durationSeconds).toBeNull();
  });

  it('keeps what it read from a truncated file', () => {
    const file = m4a({ items: { '©nam': dataBox(1, utf8('Intero')), covr: dataBox(13, JPEG) } });
    const covrStart = file.lastIndexOf(0xd8) - 1;
    const tags = parseMp4Tags(file.subarray(0, covrStart + 4));
    expect(tags).toMatchObject({ title: 'Intero', artwork: null });
  });

  it('survives broken box sizes', () => {
    const tiny = new Uint8Array([...ftyp, ...u32(4), ...ascii('moov'), ...zeros(32)]);
    expect(parseMp4Tags(tiny).title).toBeNull();
    const huge = new Uint8Array([
      ...ftyp,
      ...u32(0xffffffff),
      ...ascii('moov'),
      ...box('udta', []),
    ]);
    expect(parseMp4Tags(huge).title).toBeNull();
    const badData = m4a({ items: { '©nam': box('data', [0, 0, 0, 1]) } });
    expect(parseMp4Tags(badData).title).toBeNull();
    const badType = new Uint8Array([...ftyp, ...u32(16), 0x01, 0x02, 0x03, 0x04, ...zeros(8)]);
    expect(parseMp4Tags(badType).title).toBeNull();
  });

  it('never throws on random input', () => {
    const random = mulberry32(7);
    for (let i = 0; i < 400; i++) {
      const bytes = new Uint8Array(Math.floor(random() * 500) + 40);
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(random() * 256);
      bytes.set([...u32(24), ...ascii('ftyp')], 0);
      bytes.set([...u32(Math.floor(random() * 600)), ...ascii('moov')], 24);
      if (bytes.length > 40) bytes.set([...u32(Math.floor(random() * 400)), ...ascii('udta')], 32);
      expectSafe(parseMp4Tags(bytes));
    }
  });
});

// --- Lettura da Blob ------------------------------------------------------------------------

describe('readAudioTags', () => {
  it('reads ID3v2 from the start of an MP3 and completes missing fields from ID3v1', async () => {
    const v2 = id3(3, frame23('TIT2', text.latin1('Dal v2')));
    const audio = new Uint8Array(4096).fill(0xaa);
    const bytes = new Uint8Array([...v2, ...audio, ...id3v1('Dal v1', 'Artista v1', 'Album v1')]);
    const { blob, reads } = trackedBlob(bytes);
    expect(await readAudioTags(blob)).toMatchObject({
      title: 'Dal v2',
      artist: 'Artista v1',
      album: 'Album v1',
    });
    const total = reads.reduce((sum, [start, end]) => sum + (end - start), 0);
    expect(total).toBeLessThan(v2.length + 256);
  });

  it('reads ID3v1 when an MP3 has no ID3v2 tag', async () => {
    const bytes = new Uint8Array([
      0xff,
      0xfb,
      0x90,
      0x00,
      ...zeros(500),
      ...id3v1('Solo v1', 'A', 'B'),
    ]);
    expect((await readAudioTags(new Blob([bytes]))).title).toBe('Solo v1');
  });

  it('never reads more than 2 MiB at once, even for a huge declared ID3 size', async () => {
    const header = [...ascii('ID3'), 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f];
    const body = frame24('TIT2', text.latin1('Grande'));
    const bytes = new Uint8Array(MAX_TAG_BYTES + 4096);
    bytes.set([...header, ...body], 0);
    const { blob, reads } = trackedBlob(bytes);
    expect((await readAudioTags(blob)).title).toBe('Grande');
    for (const [start, end] of reads) expect(end - start).toBeLessThanOrEqual(MAX_TAG_BYTES);
  });

  it('finds moov after a large mdat by reading only box headers', async () => {
    const file = m4a({ items: STANDARD_ITEMS, mdatBytes: 3 * 1024 * 1024, moovFirst: false });
    const { blob, reads } = trackedBlob(file);
    const tags = await readAudioTags(blob);
    expect(tags).toMatchObject({
      title: 'Titolo',
      artist: 'Artista',
      album: 'Album',
      durationSeconds: 215,
    });
    expect(tags.artwork?.mimeType).toBe('image/jpeg');
    const total = reads.reduce((sum, [start, end]) => sum + (end - start), 0);
    expect(total).toBeLessThan(4096);
  });

  it('reads at most 2 MiB of tag boxes in total, only the first udta and the first meta', async () => {
    const MIB = 1024 * 1024;
    const concat = (parts: Array<Uint8Array | number[]>) => {
      const arrays = parts.map((part) =>
        part instanceof Uint8Array ? part : new Uint8Array(part),
      );
      const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of arrays) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };
    const bigBox = (type: string, parts: Array<Uint8Array | number[]>) => {
      const payload = concat(parts);
      return concat([[...u32(8 + payload.length), ...ascii(type)], payload]);
    };
    const filler = (bytes: number) => bigBox('free', [new Uint8Array(bytes)]);
    const meta = (items: Record<string, number[]>, extra: Uint8Array, fullBox = true) =>
      bigBox('meta', [fullBox ? [0, 0, 0, 0] : [], hdlr, ilst(items), extra]);
    const total = (reads: Array<[number, number]>) =>
      reads.reduce((sum, [start, end]) => sum + (end - start), 0);

    // Tanti udta da 1 MiB con tag incompleti: si legge solo il primo.
    const udtas = Array.from({ length: 6 }, (_, i) =>
      bigBox('udta', [meta({ '©nam': dataBox(1, utf8(`Titolo ${i}`)) }, filler(MIB))]),
    );
    const many = concat([ftyp, bigBox('moov', [mvhd0(1000, 90_000), ...udtas]), box('mdat', [])]);
    const first = trackedBlob(many);
    expect(await readAudioTags(first.blob)).toMatchObject({
      title: 'Titolo 0',
      durationSeconds: 90,
    });
    expect(total(first.reads)).toBeLessThan(MIB + 4096);

    // udta e meta di moov da 1,5 MiB ciascuno: insieme non superano il budget di 2 MiB.
    const split = concat([
      ftyp,
      bigBox('moov', [
        mvhd0(1000, 90_000),
        bigBox('udta', [meta({ '©nam': dataBox(1, utf8('Dal udta')) }, filler(1.5 * MIB))]),
        meta({ '©ART': dataBox(1, utf8('Dal meta')) }, filler(1.5 * MIB), false),
      ]),
    ]);
    const second = trackedBlob(split);
    expect(await readAudioTags(second.blob)).toMatchObject({
      title: 'Dal udta',
      artist: 'Dal meta',
    });
    expect(total(second.reads)).toBeLessThan(MAX_TAG_BYTES + 4096);

    // Tag completi nel udta: il meta di moov non si legge più.
    const complete = concat([
      ftyp,
      bigBox('moov', [
        mvhd0(1000, 90_000),
        bigBox('udta', [meta(STANDARD_ITEMS, new Uint8Array(0))]),
        meta({ '©nam': dataBox(1, utf8('Mai letto')) }, filler(MIB), false),
      ]),
    ]);
    const third = trackedBlob(complete);
    expect(await readAudioTags(third.blob)).toMatchObject({ title: 'Titolo', album: 'Album' });
    expect(total(third.reads)).toBeLessThan(4096);
  });

  it('reads a moov placed before the audio, also with 64-bit mdat', async () => {
    const meta = box('meta', [0, 0, 0, 0, ...hdlr, ...ilst({ '©nam': dataBox(1, utf8('Prima')) })]);
    const file = new Uint8Array([
      ...ftyp,
      ...box('moov', box('udta', meta)),
      ...box64('mdat', zeros(100)),
    ]);
    expect((await readAudioTags(new Blob([file]))).title).toBe('Prima');
  });

  it('returns empty tags for empty, unreadable or unknown files', async () => {
    expect(await readAudioTags(new Blob([]))).toMatchObject({ title: null, artwork: null });
    expect((await readAudioTags(new Blob([new Uint8Array(64).fill(7)]))).title).toBeNull();
    const failing = {
      size: 1000,
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
    } as unknown as Blob;
    expect(await readAudioTags(failing)).toMatchObject({ title: null, artist: null });
  });

  it('never throws on random files', async () => {
    const random = mulberry32(99);
    for (let i = 0; i < 60; i++) {
      const bytes = new Uint8Array(Math.floor(random() * 400) + 16);
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(random() * 256);
      if (i % 3 === 0) bytes.set([...ascii('ID3'), 3, 0, 0], 0);
      if (i % 3 === 1) bytes.set([...u32(16), ...ascii('ftyp')], 0);
      expectSafe(await readAudioTags(new Blob([bytes])));
    }
  });
});

// --- Nome del file e testo ------------------------------------------------------------------

describe('tagsFromFileName', () => {
  it.each([
    ['Artista - Titolo.mp3', { artist: 'Artista', title: 'Titolo' }],
    ['Lucio Dalla – Caruso.m4a', { artist: 'Lucio Dalla', title: 'Caruso' }],
    ['A - B - C.mp3', { artist: 'A', title: 'B - C' }],
    ['01 - Solo titolo.mp3', { artist: null, title: 'Solo titolo' }],
    ['03 - Band - Brano.flac', { artist: 'Band', title: 'Brano' }],
    ['01. Brano numerato.mp3', { artist: null, title: 'Brano numerato' }],
    ['99 Problems.mp3', { artist: null, title: '99 Problems' }],
    ['my_song_name.ogg', { artist: null, title: 'my song name' }],
    ['Canzone.flac', { artist: null, title: 'Canzone' }],
    ['senza estensione', { artist: null, title: 'senza estensione' }],
    ['cartella/sotto\\Artista - Titolo.wav', { artist: 'Artista', title: 'Titolo' }],
    ['Trattino-senza-spazi.mp3', { artist: null, title: 'Trattino-senza-spazi' }],
    ['‮evil\u0007 - name.mp3', { artist: 'evil', title: 'name' }],
    ['.mp3', { artist: null, title: '.mp3' }],
    ['\u0001\u0002.mp3', { artist: null, title: 'Brano senza titolo' }],
  ])('%s', (name, expected) => {
    expect(tagsFromFileName(name)).toEqual(expected);
  });

  it('caps very long names at 200 characters', () => {
    const { title } = tagsFromFileName(`${'n'.repeat(500)}.mp3`);
    expect(title).toHaveLength(200);
  });
});

describe('tag text and images', () => {
  it('sanitises text', () => {
    expect(sanitizeTagText('  ciao  mondo \r\n')).toBe('ciao mondo');
    expect(sanitizeTagText('﻿BOM⁦iso⁩')).toBe('BOMiso');
    expect(sanitizeTagText('\u0000\u001f\u007f\u009f')).toBeNull();
    expect(sanitizeTagText('lone \ud800 surrogate')).toBe('lone surrogate');
    expect(sanitizeTagText('abc', 2)).toBe('ab');
    expect(sanitizeTagText('ab cd', 3)).toBe('ab');
    expect(sanitizeTagText(null)).toBeNull();
  });

  it('sniffs image signatures', () => {
    expect(sniffImageType(new Uint8Array(JPEG))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array(PNG))).toBe('image/png');
    expect(sniffImageType(new Uint8Array(WEBP))).toBe('image/webp');
    expect(sniffImageType(new Uint8Array(GIF))).toBeNull();
    expect(acceptArtwork(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('copies accepted artwork into its own buffer', () => {
    const source = new Uint8Array([...zeros(4), ...JPEG]);
    const image = acceptArtwork(source.subarray(4));
    expect(image?.bytes.buffer).not.toBe(source.buffer);
    expect(image?.bytes.byteLength).toBe(JPEG.length);
  });
});
