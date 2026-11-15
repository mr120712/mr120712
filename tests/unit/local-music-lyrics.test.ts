// @polsia:user-owned — testo incorporato nei file del dispositivo ("La tua musica"), letto nel
// browser e mai inviato: ID3v2 USLT/SYLT (anche v2.2 ULT), MP4 '©lyr', commenti Vorbis dei FLAC.
// Solo i file dell'ascoltatore: mai i brani scaricati (Audius, podcast, copie dei brani in evidenza).
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  loadLocalLyrics,
  lyricsFromVorbisComments,
  parseSyltFrame,
  readLocalLyrics,
} from '@/lib/local-music/lyrics';
import { readAudioTags } from '@/lib/local-music/tags';
import type { LocalTrack } from '@/lib/local-music/types';

const encoder = new TextEncoder();
const utf8 = (value: string) => [...encoder.encode(value)];
const latin1 = (value: string) => [...value].map((char) => char.charCodeAt(0) & 0xff);
function utf16le(value: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out.push(code & 0xff, code >> 8);
  }
  return out;
}
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const syncsafe = (value: number) => [
  (value >> 21) & 0x7f,
  (value >> 14) & 0x7f,
  (value >> 7) & 0x7f,
  value & 0x7f,
];

function frameV23(id: string, data: number[]): number[] {
  return [...latin1(id), ...be32(data.length), 0, 0, ...data];
}
function frameV24(id: string, data: number[]): number[] {
  return [...latin1(id), ...syncsafe(data.length), 0, 0, ...data];
}
function frameV22(id: string, data: number[]): number[] {
  const n = data.length;
  return [...latin1(id), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, ...data];
}
function id3(major: 2 | 3 | 4, frames: number[][], audio = 2000): Blob {
  const body = frames.flat();
  return new Blob([
    new Uint8Array([0x49, 0x44, 0x33, major, 0, 0, ...syncsafe(body.length), ...body]),
    new Uint8Array(audio),
  ]);
}

const usltUtf8 = (text: string) => [3, ...latin1('ita'), 0, ...utf8(text)];

describe('readLocalLyrics: MP3 (ID3v2)', () => {
  it('USLT UTF-8 (v2.3): testo semplice con le righe', async () => {
    const lyrics = await readLocalLyrics(
      id3(3, [frameV23('TIT2', [3, ...utf8('Titolo')]), frameV23('USLT', usltUtf8('Uno\nDue'))]),
    );
    expect(lyrics).toEqual({
      kind: 'plain',
      lines: [
        { timeMs: null, text: 'Uno' },
        { timeMs: null, text: 'Due' },
      ],
    });
  });

  it('USLT con LRC dentro: sincronizzato; testi oltre 4 KB letti per intero', async () => {
    const lrc = Array.from(
      { length: 400 },
      (_, index) =>
        `[${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.00]Riga numero ${index}`,
    ).join('\n');
    expect(lrc.length).toBeGreaterThan(4096);
    const lyrics = await readLocalLyrics(id3(3, [frameV23('USLT', usltUtf8(lrc))]));
    expect(lyrics?.kind).toBe('synced');
    expect(lyrics?.lines).toHaveLength(400);
    expect(lyrics?.lines[399]).toEqual({ timeMs: 399_000, text: 'Riga numero 399' });
  });

  it('SYLT UTF-16 con BOM in millisecondi (v2.4) vince su USLT', async () => {
    const bom = [0xff, 0xfe];
    const sylt = [
      1,
      ...latin1('ita'),
      2, // millisecondi
      1, // testo
      ...bom,
      0,
      0, // descrizione vuota
      ...bom,
      ...utf16le('Città'),
      0,
      0,
      ...be32(1500),
      ...bom,
      ...utf16le('\nmare'),
      0,
      0,
      ...be32(4000),
    ];
    const lyrics = await readLocalLyrics(
      id3(4, [frameV24('USLT', usltUtf8('Semplice')), frameV24('SYLT', sylt)]),
    );
    expect(lyrics).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 1500, text: 'Città' },
        { timeMs: 4000, text: 'mare' },
      ],
    });
  });

  it('ULT Latin-1 (v2.2)', async () => {
    const ult = [0, ...latin1('ita'), 0, ...latin1('Perché no')];
    const lyrics = await readLocalLyrics(id3(2, [frameV22('ULT', ult)]));
    expect(lyrics?.lines[0]?.text).toBe('Perché no');
  });

  it('SYLT a frame MPEG: solo il testo (tempi non convertibili)', () => {
    const sylt = [
      3,
      ...latin1('ita'),
      1,
      1,
      0,
      ...utf8('Uno'),
      0,
      ...be32(10),
      ...utf8('Due'),
      0,
      ...be32(20),
    ];
    expect(parseSyltFrame(new Uint8Array(sylt))).toEqual({
      kind: 'plain',
      lines: [
        { timeMs: null, text: 'Uno' },
        { timeMs: null, text: 'Due' },
      ],
    });
    expect(parseSyltFrame(new Uint8Array([9, 0, 0]))).toBeNull();
  });

  it('nessun testo o tag rovinato: null; i tag di titolo/artista restano invariati', async () => {
    const blob = id3(3, [frameV23('TIT2', [3, ...utf8('Solo titolo')])]);
    expect(await readLocalLyrics(blob)).toBeNull();
    expect((await readAudioTags(blob)).title).toBe('Solo titolo');
    // Frame USLT che dichiara più byte di quelli presenti.
    const broken = new Blob([
      new Uint8Array([
        0x49,
        0x44,
        0x33,
        3,
        0,
        0,
        ...syncsafe(20),
        ...latin1('USLT'),
        ...be32(9999),
      ]),
    ]);
    expect(await readLocalLyrics(broken)).toBeNull();
    expect(await readLocalLyrics(new Blob([]))).toBeNull();
    expect(await readLocalLyrics(new Blob([new Uint8Array(64).fill(7)]))).toBeNull();
  });

  it('MP3 scritto da ffmpeg: TXXX "USLT" (v2.3 e v2.4), TXX "LYRICS" (v2.2), UTF-16', async () => {
    const lrc = '[00:01.00]Prima riga\n[00:03.50]Seconda riga';
    const synced = {
      kind: 'synced',
      lines: [
        { timeMs: 1000, text: 'Prima riga' },
        { timeMs: 3500, text: 'Seconda riga' },
      ],
    };
    const txxxUtf8 = (description: string, value: string) => [
      3,
      ...latin1(description),
      0,
      ...utf8(value),
    ];
    expect(await readLocalLyrics(id3(3, [frameV23('TXXX', txxxUtf8('USLT', lrc))]))).toEqual(
      synced,
    );
    expect(await readLocalLyrics(id3(4, [frameV24('TXXX', txxxUtf8('USLT', lrc))]))).toEqual(
      synced,
    );
    expect(
      await readLocalLyrics(
        id3(2, [frameV22('TXX', [0, ...latin1('LYRICS'), 0, ...latin1('Già')])]),
      ),
    ).toEqual({ kind: 'plain', lines: [{ timeMs: null, text: 'Già' }] });
    const bom = [0xff, 0xfe];
    const txxxUtf16 = [1, ...bom, ...utf16le('unsyncedlyrics'), 0, 0, ...bom, ...utf16le('Città')];
    expect((await readLocalLyrics(id3(3, [frameV23('TXXX', txxxUtf16)])))?.lines).toEqual([
      { timeMs: null, text: 'Città' },
    ]);
  });

  it('TXXX solo come riserva: un vero USLT vince; un TXXX qualunque non è un testo', async () => {
    const txxx = [3, ...latin1('USLT'), 0, ...utf8('[00:01.00]Da ffmpeg')];
    expect(
      (
        await readLocalLyrics(
          id3(3, [frameV23('TXXX', txxx), frameV23('USLT', usltUtf8('Dal vero USLT'))]),
        )
      )?.lines,
    ).toEqual([{ timeMs: null, text: 'Dal vero USLT' }]);
    expect(
      await readLocalLyrics(
        id3(3, [frameV23('TXXX', [3, ...latin1('comment'), 0, ...utf8('Non un testo')])]),
      ),
    ).toBeNull();
    // Frame troncato: nessun errore.
    expect(await readLocalLyrics(id3(3, [frameV23('TXXX', [3, ...latin1('USLT')])]))).toBeNull();
  });
});

function box(type: number[] | string, payload: number[]): number[] {
  const typeBytes = typeof type === 'string' ? latin1(type) : type;
  return [...be32(8 + payload.length), ...typeBytes, ...payload];
}

describe('readLocalLyrics: M4A (©lyr)', () => {
  it('testo dalla voce iTunes ©lyr in moov/udta/meta/ilst', async () => {
    const lyr = box(
      [0xa9, 0x6c, 0x79, 0x72],
      box('data', [...be32(1), ...be32(0), ...utf8('[00:02.00]Uno\n[00:05.00]Due')]),
    );
    const meta = box('meta', [
      ...be32(0),
      ...box('hdlr', new Array(25).fill(0)),
      ...box('ilst', lyr),
    ]);
    const moov = box('moov', box('udta', meta));
    const file = [
      ...box('ftyp', latin1('M4A isom')),
      ...moov,
      ...box('mdat', new Array(500).fill(0)),
    ];
    const lyrics = await readLocalLyrics(new Blob([new Uint8Array(file)]));
    expect(lyrics).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 2000, text: 'Uno' },
        { timeMs: 5000, text: 'Due' },
      ],
    });
  });
});

function flacBlock(type: number, body: number[], last = false): number[] {
  const n = body.length;
  return [(last ? 0x80 : 0) | type, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, ...body];
}
function vorbis(comments: string[]): number[] {
  const vendor = utf8('test');
  return [
    ...le32(vendor.length),
    ...vendor,
    ...le32(comments.length),
    ...comments.flatMap((comment) => {
      const bytes = utf8(comment);
      return [...le32(bytes.length), ...bytes];
    }),
  ];
}

describe('readLocalLyrics: FLAC (commenti Vorbis)', () => {
  it('LYRICS dopo un blocco immagine; UNSYNCEDLYRICS come riserva', async () => {
    const file = [
      ...latin1('fLaC'),
      ...flacBlock(0, new Array(34).fill(0)),
      ...flacBlock(6, new Array(3000).fill(1)),
      ...flacBlock(4, vorbis(['TITLE=Brano', 'lyrics=Verso uno\nVerso due']), true),
      ...new Array(100).fill(0),
    ];
    expect((await readLocalLyrics(new Blob([new Uint8Array(file)])))?.lines).toEqual([
      { timeMs: null, text: 'Verso uno' },
      { timeMs: null, text: 'Verso due' },
    ]);
    expect(lyricsFromVorbisComments(new Uint8Array(vorbis(['UNSYNCEDLYRICS=Altro'])))).toBe(
      'Altro',
    );
    expect(lyricsFromVorbisComments(new Uint8Array(vorbis(['ARTIST=Io'])))).toBeNull();
    // Lunghezze false: nessuna eccezione.
    expect(lyricsFromVorbisComments(new Uint8Array([...le32(999), 0, 0]))).toBeNull();
  });
});

describe('loadLocalLyrics', () => {
  const track = (source?: LocalTrack['source']): LocalTrack => ({
    id: 'abc',
    title: 'Brano',
    artist: null,
    album: null,
    durationSeconds: null,
    mimeType: 'audio/mpeg',
    size: 10,
    addedAt: 0,
    hasArtwork: false,
    source,
  });

  it('file dell’ascoltatore: testo con fonte "local" e credito "Dal tuo file"', async () => {
    const reader = {
      getTrack: vi.fn(async () => track()),
      getTrackBlob: vi.fn(async () => id3(3, [frameV23('USLT', usltUtf8('Mio'))])),
    };
    expect(await loadLocalLyrics('abc', reader)).toEqual({
      kind: 'plain',
      lines: [{ timeMs: null, text: 'Mio' }],
      source: 'local',
      credit: 'Dal tuo file',
    });
  });

  it('brani scaricati (Audius, podcast, copia di un brano in evidenza) esclusi: il file non si legge nemmeno', async () => {
    for (const source of ['audius-download', 'podcast-download', 'featured-download'] as const) {
      const reader = {
        getTrack: vi.fn(async () => track(source)),
        getTrackBlob: vi.fn(async () => id3(3, [frameV23('USLT', usltUtf8('No'))])),
      };
      expect(await loadLocalLyrics('abc', reader)).toBeNull();
      expect(reader.getTrackBlob).not.toHaveBeenCalled();
    }
  });

  it('brano non più sul dispositivo o libreria non leggibile: null', async () => {
    expect(
      await loadLocalLyrics('abc', {
        getTrack: vi.fn(async () => null),
        getTrackBlob: vi.fn(async () => null),
      }),
    ).toBeNull();
    expect(
      await loadLocalLyrics('abc', {
        getTrack: vi.fn(async () => {
          throw new Error('idb');
        }),
        getTrackBlob: vi.fn(async () => null),
      }),
    ).toBeNull();
  });
});
