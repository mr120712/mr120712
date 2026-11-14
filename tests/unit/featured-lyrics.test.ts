// @polsia:user-owned — testi dei brani in evidenza: il permesso viene SOLO da diritti.json
// ("testo": true su una voce valida di un file esistente); poi file .lrc, .txt e testo incorporato
// in quest'ordine; i file di testo non diventano mai brani o copertine in Home; il testo
// incorporato si legge solo dai primi 4 MB (Range); cache; mai eccezioni.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('music-metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('music-metadata')>();
  return { ...actual, parseBuffer: vi.fn(actual.parseBuffer) };
});

import { parseBuffer } from 'music-metadata';
import { lyricsFromMetadata } from '@/lib/music/embedded-lyrics';
import {
  clearFeaturedLyricsCacheForTests,
  EMBEDDED_LYRICS_MAX_BYTES,
  LYRICS_SIDECAR_MAX_BYTES,
  readFeaturedLyrics,
} from '@/lib/music/featured-lyrics.server';
import {
  declaredTrackEntries,
  lyricsDeclared,
  parseRightsManifest,
} from '@/lib/music/featured-rights.server';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';
import {
  isHomeAudioBlob,
  isHomeImageBlob,
  isHomeLyricsSidecar,
  listHomeTrackSections,
} from '@/lib/music/home-tracks.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const encoder = new TextEncoder();

type StoreFile = { pathname: string; bytes: Uint8Array; uploadedAt?: string };

/** Lo store finto: elenco (list) e contenuti (get, con o senza Range). */
let store: StoreFile[] = [];
let rangeSupported = true;
let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

function listed(file: StoreFile) {
  const url = `${PRIVATE}/${file.pathname.split('/').map(encodeURIComponent).join('/')}`;
  return {
    pathname: file.pathname,
    url,
    downloadUrl: url,
    size: file.bytes.length,
    uploadedAt: new Date(file.uploadedAt ?? '2026-01-01T00:00:00.000Z'),
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function manifest(entries: unknown[]): StoreFile {
  return { pathname: 'diritti.json', bytes: text(JSON.stringify({ versione: 1, brani: entries })) };
}

function syncsafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function id3Frame(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + data.length);
  out.set(text(id), 0);
  out[4] = (data.length >>> 24) & 0xff;
  out[5] = (data.length >>> 16) & 0xff;
  out[6] = (data.length >>> 8) & 0xff;
  out[7] = data.length & 0xff;
  out.set(data, 10);
  return out;
}

/** Un MP3 vero in miniatura: tag ID3v2.3 con USLT (UTF-8), frame MPEG muti e `audioBytes` di coda. */
function mp3WithUslt(lyrics: string, audioBytes = 0): Uint8Array {
  return mp3WithFrames(
    [id3Frame('USLT', new Uint8Array([3, ...text('ita'), 0, ...text(lyrics)]))],
    audioBytes,
  );
}

/** Frame TXXX (UTF-8) come lo scrive ffmpeg con `-metadata lyrics=…`: descrizione "USLT". */
function txxxFrame(description: string, value: string): Uint8Array {
  return id3Frame('TXXX', new Uint8Array([3, ...text(description), 0, ...text(value)]));
}

function mp3WithFrames(frames: Uint8Array[], audioBytes = 0): Uint8Array {
  const tagBody = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    tagBody.set(frame, at);
    at += frame.length;
  }
  const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(tagBody.length)]);
  const mpeg = new Uint8Array(417 * 8 + audioBytes);
  for (let index = 0; index < 8; index += 1) mpeg.set([0xff, 0xfb, 0x90, 0x64], index * 417);
  const out = new Uint8Array(header.length + tagBody.length + mpeg.length);
  out.set(header, 0);
  out.set(tagBody, header.length);
  out.set(mpeg, header.length + tagBody.length);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Le voci ignorate del manifest finiscono nei log del server: qui non servono.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.token = 'tok_test';
  rangeSupported = true;
  store = [];
  clearFeaturedSearchCacheForTests();
  clearFeaturedLyricsCacheForTests();
  mocks.list.mockImplementation(async () => ({ blobs: store.map(listed), hasMore: false }));
  mocks.get.mockImplementation(
    async (path: string, options: { headers?: { range?: string } } = {}) => {
      const pathname = path.split('/').map(decodeURIComponent).join('/');
      const file = store.find((item) => item.pathname === pathname);
      if (!file) return null;
      const range = options.headers?.range;
      const match = range && rangeSupported ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (match) {
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), file.bytes.length - 1);
        const part = file.bytes.slice(start, end + 1);
        return {
          statusCode: 200,
          stream: streamOf(part),
          headers: new Headers({
            'content-length': String(part.length),
            'content-range': `bytes ${start}-${end}/${file.bytes.length}`,
          }),
        };
      }
      return {
        statusCode: 200,
        stream: streamOf(file.bytes),
        headers: new Headers({ 'content-length': String(file.bytes.length) }),
      };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  warnSpy?.mockRestore();
});

/** I pathname letti con get() (escluso il manifest). */
function readPaths(): string[] {
  return mocks.get.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path !== 'diritti.json')
    .map((path) => path.split('/').map(decodeURIComponent).join('/'));
}

const SONG = 'Cantautori/Autrice - Canzone.mp3';
const ENTRY = { file: SONG, licenza: 'propria', titolare: 'Autrice' };
const LRC = '[ar:Autrice]\n[00:01.00]Prima riga\n[00:04.50]Seconda riga';

describe('readFeaturedLyrics: il permesso viene solo da diritti.json', () => {
  it('brano non dichiarato nel manifest → null, nessun file di testo letto', async () => {
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Testo incorporato') },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(LRC) },
      manifest([{ ...ENTRY, file: 'Altro.mp3', testo: true }]),
    ];
    expect(await readFeaturedLyrics(SONG)).toBeNull();
    expect(readPaths()).toEqual([]);
  });

  it('dichiarato SENZA "testo" o con "testo": false → null (la licenza non basta)', async () => {
    for (const entry of [ENTRY, { ...ENTRY, testo: false }]) {
      clearFeaturedSearchCacheForTests();
      clearFeaturedLyricsCacheForTests();
      mocks.get.mockClear();
      store = [
        { pathname: SONG, bytes: mp3WithUslt('Testo incorporato') },
        { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(LRC) },
        manifest([entry]),
      ];
      expect(await readFeaturedLyrics(SONG)).toBeNull();
      expect(readPaths()).toEqual([]);
    }
  });

  it('"testo" non booleano rende la voce non valida; manifest non valido o assente → null', async () => {
    store = [{ pathname: SONG, bytes: mp3WithUslt('x') }, manifest([{ ...ENTRY, testo: 'si' }])];
    expect(await readFeaturedLyrics(SONG)).toBeNull();

    clearFeaturedSearchCacheForTests();
    store = [
      { pathname: SONG, bytes: mp3WithUslt('x') },
      { pathname: 'diritti.json', bytes: text('{ non json') },
    ];
    expect(await readFeaturedLyrics(SONG)).toBeNull();

    clearFeaturedSearchCacheForTests();
    store = [{ pathname: SONG, bytes: mp3WithUslt('x') }];
    expect(await readFeaturedLyrics(SONG)).toBeNull();
    expect(readPaths()).toEqual([]);
  });

  it('voci ripetute in disaccordo sul testo → null, in qualunque ordine (nel dubbio si esclude)', async () => {
    // Stesso file scritto con un'altra forma Unicode (NFD, come da un Mac): è sempre lo stesso brano.
    const accented = 'Cantautori/Autrice - Città.mp3';
    const accentedEntry = { ...ENTRY, file: accented };
    for (const [song, entries] of [
      [
        SONG,
        [
          { ...ENTRY, testo: true },
          { ...ENTRY, testo: false },
        ],
      ],
      [SONG, [ENTRY, { ...ENTRY, testo: true }]],
      [
        accented,
        [
          { ...accentedEntry, testo: true },
          { ...accentedEntry, file: accented.normalize('NFD'), testo: false },
        ],
      ],
      [
        accented,
        [
          { ...accentedEntry, file: accented.normalize('NFD') },
          { ...accentedEntry, testo: true },
        ],
      ],
    ] as const) {
      clearFeaturedSearchCacheForTests();
      clearFeaturedLyricsCacheForTests();
      mocks.get.mockClear();
      store = [{ pathname: song, bytes: mp3WithUslt('Testo incorporato') }, manifest([...entries])];
      expect(await readFeaturedLyrics(song)).toBeNull();
      expect(readPaths()).toEqual([]);
    }
    // Controprova: la stessa voce accentata da sola, con "testo": true, mostra il testo.
    clearFeaturedSearchCacheForTests();
    clearFeaturedLyricsCacheForTests();
    store = [
      { pathname: accented, bytes: mp3WithUslt('Testo incorporato') },
      manifest([{ ...accentedEntry, testo: true }]),
    ];
    expect(await readFeaturedLyrics(accented)).not.toBeNull();

    // Tutte con "testo": true: il testo si mostra (credito dalla prima voce).
    clearFeaturedSearchCacheForTests();
    clearFeaturedLyricsCacheForTests();
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Testo incorporato') },
      manifest([
        { ...ENTRY, testo: true },
        { ...ENTRY, titolare: 'Altro', testo: true },
      ]),
    ];
    expect(await readFeaturedLyrics(SONG)).toMatchObject({
      lines: [{ timeMs: null, text: 'Testo incorporato' }],
      credit: 'Testo: Autrice',
    });
  });

  it('il credito perde caratteri di controllo e override bidi; se non resta nulla, nessun credito', async () => {
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Riga') },
      manifest([{ ...ENTRY, titolare: '‮etitolare\u0007', testo: true }]),
    ];
    expect((await readFeaturedLyrics(SONG))?.credit).toBe('Testo: etitolare');

    clearFeaturedSearchCacheForTests();
    clearFeaturedLyricsCacheForTests();
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Riga') },
      manifest([{ ...ENTRY, titolare: '​‮', testo: true }]),
    ];
    expect(await readFeaturedLyrics(SONG)).toMatchObject({
      lines: [{ text: 'Riga' }],
      credit: null,
    });
  });

  it('dichiarato con "testo": true ma file audio assente dallo store → null', async () => {
    store = [manifest([{ ...ENTRY, testo: true }])];
    expect(await readFeaturedLyrics(SONG)).toBeNull();
  });

  it('senza token Blob → null', async () => {
    mocks.token = undefined;
    expect(await readFeaturedLyrics(SONG)).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('readFeaturedLyrics: fonti del testo', () => {
  it('.lrc preferito al .txt e al testo incorporato; credito dal titolare', async () => {
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Incorporato') },
      { pathname: 'Cantautori/Autrice - Canzone.txt', bytes: text('Semplice') },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(LRC) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    expect(await readFeaturedLyrics(SONG)).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 1000, text: 'Prima riga' },
        { timeMs: 4500, text: 'Seconda riga' },
      ],
      source: 'featured',
      credit: 'Testo: Autrice',
    });
    expect(readPaths()).toEqual(['Cantautori/Autrice - Canzone.lrc']);
  });

  it('.txt (estensione maiuscola, BOM ammesso) quando manca il .lrc', async () => {
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Incorporato') },
      {
        pathname: 'Cantautori/Autrice - Canzone.TXT',
        bytes: text(`${String.fromCharCode(0xfeff)}Strofa\nancora`),
      },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    const lyrics = await readFeaturedLyrics(SONG);
    expect(lyrics?.kind).toBe('plain');
    expect(lyrics?.lines.map((line) => line.text)).toEqual(['Strofa', 'ancora']);
  });

  it('un file di testo con un altro nome (o in un’altra cartella) non vale', async () => {
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Dal file audio') },
      { pathname: 'Autrice - Canzone.lrc', bytes: text(LRC) },
      { pathname: 'Cantautori/autrice - canzone.lrc', bytes: text(LRC) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    const lyrics = await readFeaturedLyrics(SONG);
    expect(lyrics?.lines.map((line) => line.text)).toEqual(['Dal file audio']);
  });

  it('.lrc oltre 64 KB o non UTF-8 → si passa al .txt, poi al testo incorporato', async () => {
    const big = new Uint8Array(LYRICS_SIDECAR_MAX_BYTES + 1).fill(0x61);
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Incorporato') },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: big },
      { pathname: 'Cantautori/Autrice - Canzone.txt', bytes: new Uint8Array([0xff, 0xfe, 0xc3]) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    const lyrics = await readFeaturedLyrics(SONG);
    expect(lyrics?.lines.map((line) => line.text)).toEqual(['Incorporato']);
    // Il .lrc troppo grande non si scarica nemmeno (dimensione dall'elenco).
    expect(readPaths()).toEqual(['Cantautori/Autrice - Canzone.txt', SONG]);
  });

  it('testo incorporato (USLT di un MP3 vero), con LRC dentro → sincronizzato', async () => {
    store = [
      { pathname: SONG, bytes: mp3WithUslt('[00:02.00]Dal tag\n[00:03.00]ID3') },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    const lyrics = await readFeaturedLyrics(SONG);
    expect(lyrics).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 2000, text: 'Dal tag' },
        { timeMs: 3000, text: 'ID3' },
      ],
      source: 'featured',
      credit: 'Testo: Autrice',
    });
    // Una sola richiesta Range dei primi 4 MB.
    const audioCall = mocks.get.mock.calls.find(([path]) => String(path).endsWith('.mp3'));
    expect(audioCall?.[1]).toMatchObject({
      access: 'private',
      token: 'tok_test',
      headers: { range: `bytes=0-${EMBEDDED_LYRICS_MAX_BYTES - 1}` },
    });
  });

  it('MP3 scritto da ffmpeg (TXXX "USLT"): letto; un vero USLT vince sul TXXX', async () => {
    const lrc = '[00:01.00]Prima riga\n[00:03.50]Seconda riga';
    store = [
      { pathname: SONG, bytes: mp3WithFrames([txxxFrame('USLT', lrc)]) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    expect(await readFeaturedLyrics(SONG)).toMatchObject({
      kind: 'synced',
      lines: [
        { timeMs: 1000, text: 'Prima riga' },
        { timeMs: 3500, text: 'Seconda riga' },
      ],
    });

    clearFeaturedSearchCacheForTests();
    clearFeaturedLyricsCacheForTests();
    store = [
      {
        pathname: SONG,
        bytes: mp3WithFrames([
          txxxFrame('USLT', lrc),
          id3Frame('USLT', new Uint8Array([3, ...text('ita'), 0, ...text('Dal vero USLT')])),
        ]),
      },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    expect((await readFeaturedLyrics(SONG))?.lines).toEqual([
      { timeMs: null, text: 'Dal vero USLT' },
    ]);
  });

  it('testo incorporato: mai più di 4 MB letti, anche se lo storage ignora il Range', async () => {
    rangeSupported = false;
    // File da ~6 MB: lo storage manda tutto, il server ne legge solo i primi 4 MB.
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Vicino', 6 * 1024 * 1024) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    expect(await readFeaturedLyrics(SONG)).toEqual(
      expect.objectContaining({ lines: [{ timeMs: null, text: 'Vicino' }] }),
    );
    const parsed = vi.mocked(parseBuffer).mock.calls[0]?.[0] as Uint8Array | undefined;
    expect(parsed?.length).toBeLessThanOrEqual(EMBEDDED_LYRICS_MAX_BYTES);
  });

  it('niente testo da nessuna parte → null; errori dello storage → null (mai throw)', async () => {
    store = [{ pathname: SONG, bytes: mp3WithUslt('') }, manifest([{ ...ENTRY, testo: true }])];
    expect(await readFeaturedLyrics(SONG)).toBeNull();

    clearFeaturedLyricsCacheForTests();
    mocks.get.mockImplementation(async (path: string) => {
      if (path === 'diritti.json') {
        return {
          statusCode: 200,
          stream: streamOf(
            text(JSON.stringify({ versione: 1, brani: [{ ...ENTRY, testo: true }] })),
          ),
          headers: new Headers(),
        };
      }
      throw new Error('rete');
    });
    clearFeaturedSearchCacheForTests();
    await expect(readFeaturedLyrics(SONG)).resolves.toBeNull();
  });
});

describe('readFeaturedLyrics: cache', () => {
  it('~10 minuti per un testo trovato, ~2 per uno mancante', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Uno') },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(LRC) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    await readFeaturedLyrics(SONG);
    await readFeaturedLyrics(SONG);
    expect(readPaths()).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-14T10:04:00.000Z'));
    await readFeaturedLyrics(SONG);
    expect(readPaths()).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-14T10:11:00.000Z'));
    await readFeaturedLyrics(SONG);
    expect(readPaths()).toHaveLength(2);

    // Mancante: si riprova dopo ~2 minuti.
    clearFeaturedSearchCacheForTests();
    clearFeaturedLyricsCacheForTests();
    mocks.get.mockClear();
    store = [{ pathname: SONG, bytes: mp3WithUslt('') }, manifest([{ ...ENTRY, testo: true }])];
    await readFeaturedLyrics(SONG);
    await readFeaturedLyrics(SONG);
    expect(readPaths()).toEqual([SONG]);
    vi.setSystemTime(new Date('2026-11-14T10:14:00.000Z'));
    await readFeaturedLyrics(SONG);
    expect(readPaths()).toEqual([SONG, SONG]);
  });

  it('una revoca ("testo" tolto) vale anche con il testo in cache, al rinnovo dell’indice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Uno') },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(LRC) },
      manifest([{ ...ENTRY, testo: true }]),
    ];
    expect(await readFeaturedLyrics(SONG)).not.toBeNull();
    store = [
      { pathname: SONG, bytes: mp3WithUslt('Uno') },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(LRC) },
      manifest([ENTRY]),
    ];
    vi.setSystemTime(new Date('2026-11-14T10:06:00.000Z'));
    expect(await readFeaturedLyrics(SONG)).toBeNull();
  });
});

describe('i file di testo non sono brani né copertine', () => {
  it('isHomeLyricsSidecar e i filtri audio/immagine', () => {
    for (const name of ['A.lrc', 'Cartella/A.LRC', 'A.txt', 'B/A.TxT']) {
      expect(isHomeLyricsSidecar(name)).toBe(true);
      expect(isHomeAudioBlob(name)).toBe(false);
      expect(isHomeImageBlob(name)).toBe(false);
    }
    for (const name of ['public-uploads/a.lrc', '../a.lrc', '/a.txt', 'a.mp3', 'a.json']) {
      expect(isHomeLyricsSidecar(name)).toBe(false);
    }
  });

  it('in Home compaiono solo i brani', async () => {
    store = [
      { pathname: 'A - Uno.mp3', bytes: new Uint8Array(10) },
      { pathname: 'A - Uno.lrc', bytes: text(LRC) },
      { pathname: 'A - Uno.txt', bytes: text('x') },
      { pathname: 'Pop/cover.txt', bytes: text('x') },
      { pathname: 'Pop/B - Due.mp3', bytes: new Uint8Array(10) },
    ];
    const { items, sections } = await listHomeTrackSections();
    expect(items.map((item) => item.id).sort()).toEqual(['A - Uno.mp3', 'Pop/B - Due.mp3']);
    const all = sections.flatMap((section) => section.items);
    expect(all.every((item) => !/\.(lrc|txt)/i.test(`${item.id} ${item.artworkUrl ?? ''}`))).toBe(
      true,
    );
  });
});

describe('lyricsFromMetadata', () => {
  it('SYLT in millisecondi vince su USLT; Vorbis, MP4 e campo comune', () => {
    expect(
      lyricsFromMetadata({
        native: {
          'ID3v2.4': [
            { id: 'USLT', value: { language: 'ita', descriptor: '', text: 'Semplice' } },
            {
              id: 'SYLT',
              value: {
                timeStampFormat: 2,
                syncText: [
                  { text: 'Uno', timestamp: 1000 },
                  { text: 'Due', timestamp: 2000 },
                ],
              },
            },
          ],
        },
        common: {} as never,
      })?.kind,
    ).toBe('synced');
    expect(
      lyricsFromMetadata({
        native: { vorbis: [{ id: 'UNSYNCEDLYRICS', value: 'Da FLAC' }] },
        common: {} as never,
      })?.lines,
    ).toEqual([{ timeMs: null, text: 'Da FLAC' }]);
    expect(
      lyricsFromMetadata({
        native: { iTunes: [{ id: '©lyr', value: 'Da M4A' }] },
        common: {} as never,
      })?.lines[0]?.text,
    ).toBe('Da M4A');
    // SYLT a frame MPEG: solo il testo.
    expect(
      lyricsFromMetadata({
        native: {
          'ID3v2.3': [
            { id: 'SYLT', value: { timeStampFormat: 1, syncText: [{ text: 'A', timestamp: 5 }] } },
          ],
        },
        common: {} as never,
      }),
    ).toEqual({ kind: 'plain', lines: [{ timeMs: null, text: 'A' }] });
    expect(
      lyricsFromMetadata({
        native: {},
        common: { lyrics: [{ text: 'Comune', syncText: [] }] } as never,
      })?.lines[0]?.text,
    ).toBe('Comune');
    expect(lyricsFromMetadata(null)).toBeNull();
    expect(
      lyricsFromMetadata({ native: { x: [{ id: 'TIT2', value: 'T' }] }, common: {} as never }),
    ).toBeNull();
  });
});

describe('lyricsFromMetadata: TXXX di ffmpeg e SYLT con l’a capo in coda', () => {
  it('TXXX:USLT / TXXX:LYRICS solo come riserva', () => {
    for (const id of ['TXXX:USLT', 'TXXX:LYRICS', 'TXXX:UNSYNCEDLYRICS', 'TXXX:unsynced lyrics']) {
      expect(
        lyricsFromMetadata({
          native: { 'ID3v2.4': [{ id, value: '[00:01.00]Uno\n[00:02.00]Due' }] },
          common: {} as never,
        })?.kind,
      ).toBe('synced');
    }
    // Un TXXX qualunque non è un testo.
    expect(
      lyricsFromMetadata({
        native: { 'ID3v2.3': [{ id: 'TXXX:comment', value: 'Non un testo' }] },
        common: {} as never,
      }),
    ).toBeNull();
    // Un vero USLT vince sul TXXX, anche se il TXXX è sincronizzato.
    expect(
      lyricsFromMetadata({
        native: {
          'ID3v2.3': [
            { id: 'TXXX:USLT', value: '[00:01.00]Da ffmpeg' },
            { id: 'USLT', value: { language: 'ita', descriptor: '', text: 'Dal USLT' } },
          ],
        },
        common: {} as never,
      })?.lines,
    ).toEqual([{ timeMs: null, text: 'Dal USLT' }]);
  });

  it('SYLT con una riga per voce chiusa da "\\n": righe separate', () => {
    expect(
      lyricsFromMetadata({
        native: {
          'ID3v2.4': [
            {
              id: 'SYLT',
              value: {
                timeStampFormat: 2,
                syncText: [
                  { text: 'Prima riga\n', timestamp: 1000 },
                  { text: 'Seconda riga\n', timestamp: 4000 },
                ],
              },
            },
          ],
        },
        common: {} as never,
      })?.lines,
    ).toEqual([
      { timeMs: 1000, text: 'Prima riga' },
      { timeMs: 4000, text: 'Seconda riga' },
    ]);
  });
});

describe('diritti.json: il campo "testo"', () => {
  it('voci ripetute: vale la prima, ma "testo" è true solo se lo dicono tutte', () => {
    const brani = (testi: (boolean | undefined)[]) =>
      JSON.stringify({
        versione: 1,
        brani: testi.map((testo) => ({ file: 'a.mp3', licenza: 'propria', titolare: 'A', testo })),
      });
    for (const [testi, expected] of [
      [[true, false], false],
      [[false, true], false],
      [[true, undefined], false],
      [[undefined, true], false],
      [[true, true], true],
    ] as const) {
      const parsed = parseRightsManifest(brani([...testi]));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.entries).toHaveLength(1);
      expect(lyricsDeclared(parsed.entries[0] ?? {})).toBe(expected);
    }
  });

  it('facoltativo e booleano: i manifest esistenti restano validi', () => {
    const parsed = parseRightsManifest(
      JSON.stringify({
        versione: 1,
        brani: [
          { file: 'a.mp3', licenza: 'propria', titolare: 'A' },
          { file: 'b.mp3', licenza: 'licenza', titolare: 'B', testo: true },
          { file: 'c.mp3', licenza: 'cc-by', titolare: 'C', testo: false },
          { file: 'd.mp3', licenza: 'propria', titolare: 'D', testo: 'si' },
          { file: 'e.mp3', licenza: 'propria', titolare: 'E', testo: 1 },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((entry) => [entry.file, lyricsDeclared(entry)])).toEqual([
      ['a.mp3', false],
      ['b.mp3', true],
      ['c.mp3', false],
    ]);
    expect(parsed.skipped).toBe(2);
    // Ogni file esistente con la sua voce (stesse regole di corrispondenza della ricerca).
    const entries = declaredTrackEntries(parsed.entries, ['b.mp3', 'z.mp3']);
    expect([...entries.keys()]).toEqual(['b.mp3']);
    expect(entries.get('b.mp3')?.titolare).toBe('B');
  });
});
