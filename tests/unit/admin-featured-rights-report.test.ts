// @polsia:user-owned — diagnosi della pagina admin «Diritti e testi»: un brano per file audio dello
// store (come in Home), testo controllato SOLO per i brani dichiarati con "testo": true (con la
// cache del player), mai il testo nella risposta (marcatori unici nei file .lrc/.txt e nei tag),
// tetto e parallelismo dei controlli con il conteggio dei saltati, un solo elenco dello store per
// richiesta (in cache ~60 s) e diritti.json sempre riletto.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  token: 'tok_test' as string | undefined,
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));

vi.mock('@vercel/blob', () => ({
  list: mocks.list,
  get: mocks.get,
  head: mocks.head,
  BlobNotFoundError: mocks.BlobNotFoundError,
}));
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
import {
  buildFeaturedRightsReport,
  clearFeaturedRightsReportCacheForTests,
  REPORT_LYRICS_CONCURRENCY,
  REPORT_MAX_LYRICS_CHECKS,
} from '@/lib/admin/featured-rights-report.server';
import {
  type AdminFeaturedRights,
  AdminFeaturedRightsSchema,
  type FeaturedRightsTrack,
} from '@/lib/contracts/admin-featured-rights';
import {
  clearFeaturedLyricsCacheForTests,
  readFeaturedLyrics,
} from '@/lib/music/featured-lyrics.server';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const encoder = new TextEncoder();
/** Marcatori unici: se compaiono nella risposta, è uscito il testo di un brano. */
const LRC_MARKER = 'MARCATORE-LRC-7f3a9c';
const TXT_MARKER = 'MARCATORE-TXT-51be02';
const TAG_MARKER = 'MARCATORE-TAG-c0ffee';
const UNDECLARED_MARKER = 'MARCATORE-NON-DICHIARATO-99d1';

type StoreFile = { pathname: string; bytes: Uint8Array; uploadedAt?: string };
let store: StoreFile[] = [];

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

/** Un MP3 vero in miniatura con il testo nel tag ID3v2.3 USLT (UTF-8). */
function mp3WithUslt(lyrics: string): Uint8Array {
  const data = new Uint8Array([3, ...text('ita'), 0, ...text(lyrics)]);
  const frame = new Uint8Array(10 + data.length);
  frame.set(text('USLT'), 0);
  frame[4] = (data.length >>> 24) & 0xff;
  frame[5] = (data.length >>> 16) & 0xff;
  frame[6] = (data.length >>> 8) & 0xff;
  frame[7] = data.length & 0xff;
  frame.set(data, 10);
  const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frame.length)]);
  const mpeg = new Uint8Array(417 * 8);
  for (let index = 0; index < 8; index += 1) mpeg.set([0xff, 0xfb, 0x90, 0x64], index * 417);
  const out = new Uint8Array(header.length + frame.length + mpeg.length);
  out.set(header, 0);
  out.set(frame, header.length);
  out.set(mpeg, header.length + frame.length);
  return out;
}

function plainMp3(): Uint8Array {
  const mpeg = new Uint8Array(417 * 8);
  for (let index = 0; index < 8; index += 1) mpeg.set([0xff, 0xfb, 0x90, 0x64], index * 417);
  return mpeg;
}

/** Percorsi letti con get(), decodificati. */
function reads(): string[] {
  return mocks.get.mock.calls.map(([path]) =>
    String(path).split('/').map(decodeURIComponent).join('/'),
  );
}

function count(pathname: string): number {
  return reads().filter((path) => path === pathname).length;
}

function track(report: AdminFeaturedRights, pathname: string): FeaturedRightsTrack {
  const row = report.tracks.find((item) => item.pathname === pathname);
  if (!row) throw new Error(`Brano ${pathname} non nella diagnosi.`);
  return row;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Nessuna rete vera: tutto passa dallo store finto.
  fetchSpy = vi.fn(() => Promise.reject(new Error('rete vietata nei test')));
  vi.stubGlobal('fetch', fetchSpy);
  mocks.token = 'tok_test';
  store = [];
  clearFeaturedRightsReportCacheForTests();
  clearFeaturedSearchCacheForTests();
  clearFeaturedLyricsCacheForTests();
  mocks.list.mockImplementation(async () => ({ blobs: store.map(listed), hasMore: false }));
  // Come lo store vero: i dati del file chiesto per nome, oppure BlobNotFoundError.
  mocks.head.mockImplementation(async (pathname: string) => {
    const file = store.find((item) => item.pathname === pathname);
    if (!file) throw new mocks.BlobNotFoundError('The requested blob does not exist');
    return listed(file);
  });
  mocks.get.mockImplementation(
    async (path: string, options: { headers?: { range?: string } } = {}) => {
      const pathname = path.split('/').map(decodeURIComponent).join('/');
      const file = store.find((item) => item.pathname === pathname);
      if (!file) return null;
      const match = options.headers?.range
        ? /^bytes=(\d+)-(\d+)$/.exec(options.headers.range)
        : null;
      const bytes = match ? file.bytes.slice(Number(match[1]), Number(match[2]) + 1) : file.bytes;
      return {
        statusCode: 200,
        stream: streamOf(bytes),
        headers: new Headers({ 'content-length': String(bytes.length) }),
      };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LRC_SONG = 'Cantautori/Autrice - Canzone.mp3';
const TXT_SONG = 'Cantautori/Autrice - Ballata.mp3';
const TAG_SONG = 'Rock/Band - Inno.mp3';
const NONE_SONG = 'Rock/Band - Strumentale.mp3';
const NO_TESTO = 'Pop/Cantante - Estate.mp3';
const UNDECLARED = 'Pop/Ignoto - Copiato.mp3';
const ROOT_SONG = 'Solista - Radice.flac';

function fullStore(): StoreFile[] {
  return [
    { pathname: LRC_SONG, bytes: plainMp3(), uploadedAt: '2026-11-07T00:00:00Z' },
    {
      pathname: 'Cantautori/Autrice - Canzone.lrc',
      bytes: text(`[00:01.00]${LRC_MARKER} prima\n[00:04.50]${LRC_MARKER} seconda`),
    },
    { pathname: TXT_SONG, bytes: plainMp3(), uploadedAt: '2026-11-06T00:00:00Z' },
    {
      pathname: 'Cantautori/Autrice - Ballata.TXT',
      bytes: text(`${TXT_MARKER} uno\n${TXT_MARKER} due\n${TXT_MARKER} tre`),
    },
    {
      pathname: TAG_SONG,
      bytes: mp3WithUslt(`${TAG_MARKER} riga`),
      uploadedAt: '2026-11-05T00:00:00Z',
    },
    { pathname: NONE_SONG, bytes: plainMp3(), uploadedAt: '2026-11-04T00:00:00Z' },
    {
      pathname: NO_TESTO,
      bytes: mp3WithUslt(`${UNDECLARED_MARKER} tag`),
      uploadedAt: '2026-11-03T00:00:00Z',
    },
    { pathname: 'Pop/Cantante - Estate.lrc', bytes: text(`[00:01.00]${UNDECLARED_MARKER}`) },
    {
      pathname: UNDECLARED,
      bytes: mp3WithUslt(`${UNDECLARED_MARKER} copia`),
      uploadedAt: '2026-11-02T00:00:00Z',
    },
    { pathname: 'Pop/Ignoto - Copiato.lrc', bytes: text(`[00:01.00]${UNDECLARED_MARKER}`) },
    { pathname: ROOT_SONG, bytes: plainMp3(), uploadedAt: '2026-11-01T00:00:00Z' },
    { pathname: 'Pop/cover.jpg', bytes: text('jpg') },
    { pathname: 'public-uploads/u1/brano.mp3', bytes: plainMp3() },
    manifest([
      { file: LRC_SONG, licenza: 'propria', titolare: 'Autrice', testo: true },
      { file: TXT_SONG, licenza: 'propria', titolare: 'Autrice', testo: true },
      { file: TAG_SONG, licenza: 'licenza', titolare: 'Etichetta Srl', testo: true },
      { file: NONE_SONG, licenza: 'cc-by', titolare: 'Band', testo: true },
      { file: NO_TESTO, licenza: 'licenza', titolare: 'Etichetta Srl' },
      { file: 'Pop/Ignoto - Copiato.mp3', licenza: 'cc-by-nc', titolare: 'Ignoto' },
      { file: 'Rock/Assente.mp3', licenza: 'propria', titolare: 'Band' },
    ]),
  ];
}

describe('buildFeaturedRightsReport: brani e diritti', () => {
  it('un brano per file audio (come la Home): niente upload, testi, copertine o manifest', async () => {
    store = fullStore();
    const report = await buildFeaturedRightsReport();
    expect(AdminFeaturedRightsSchema.parse(report)).toEqual(report);
    expect(report.tracks.map((row) => row.pathname)).toEqual([
      LRC_SONG,
      TXT_SONG,
      TAG_SONG,
      NONE_SONG,
      NO_TESTO,
      UNDECLARED,
      ROOT_SONG,
    ]);
    expect(report.store.status).toBe('ok');
    expect(report.store.listedAt).not.toBeNull();
    expect(report.tracksTruncated).toBe(false);

    expect(track(report, LRC_SONG)).toMatchObject({
      folder: 'Cantautori',
      section: 'Cantautori',
      title: 'Canzone',
      artist: 'Autrice',
      declared: true,
      licenza: 'propria',
      titolare: 'Autrice',
      testo: true,
      sidecars: { lrc: true, txt: false },
    });
    expect(track(report, ROOT_SONG)).toMatchObject({
      folder: '',
      section: 'In evidenza',
      declared: false,
      licenza: null,
      titolare: null,
      testo: false,
      sidecars: { lrc: false, txt: false },
      lyrics: { status: 'not_checked' },
    });
    expect(track(report, NO_TESTO)).toMatchObject({ declared: true, testo: false });
    expect(track(report, UNDECLARED)).toMatchObject({
      declared: false,
      sidecars: { lrc: true, txt: false },
    });
  });

  it('manifest: voci scartate e ignorate con i motivi, conteggi e riepilogo', async () => {
    store = fullStore();
    const report = await buildFeaturedRightsReport();
    expect(report.manifest.status).toBe('valid');
    expect(report.manifest.counts).toEqual({ entries: 7, valid: 5, invalid: 1, ignored: 1 });
    expect(report.manifest.problems).toEqual([
      {
        index: 6,
        file: 'Pop/Ignoto - Copiato.mp3',
        kind: 'invalid',
        reasons: ['licenza non accettata: cc-by-nc (uso non commerciale)'],
      },
      {
        index: 7,
        file: 'Rock/Assente.mp3',
        kind: 'ignored',
        reasons: [
          'file non trovato nello store: controlla cartelle, maiuscole, spazi ed estensione',
        ],
      },
    ]);
    expect(report.summary).toEqual({
      totalTracks: 7,
      declared: 5,
      declaredWithLyrics: 4,
      lyricsFound: 3,
      lyricsMissing: 1,
      lyricsErrors: 0,
      lyricsSkipped: 0,
      lyricsNotShown: 0,
      manifestProblems: 2,
      offlineAllowed: 3,
    });
  });
});

describe('buildFeaturedRightsReport: testo solo per i dichiarati con "testo": true', () => {
  it('fonte, tipo e righe; mai cercato per i non dichiarati o senza "testo": true', async () => {
    store = fullStore();
    const report = await buildFeaturedRightsReport();
    expect(track(report, LRC_SONG).lyrics).toEqual({ status: 'lrc', kind: 'synced', lineCount: 2 });
    expect(track(report, TXT_SONG).lyrics).toEqual({ status: 'txt', kind: 'plain', lineCount: 3 });
    expect(track(report, TAG_SONG).lyrics).toEqual({
      status: 'embedded',
      kind: 'plain',
      lineCount: 1,
    });
    expect(track(report, NONE_SONG).lyrics).toEqual({ status: 'none' });
    expect(track(report, NO_TESTO).lyrics).toEqual({ status: 'not_checked' });
    expect(track(report, UNDECLARED).lyrics).toEqual({ status: 'not_checked' });

    // Nessuna lettura per i brani senza permesso sul testo: né i file accanto né l'audio.
    for (const path of [
      NO_TESTO,
      'Pop/Cantante - Estate.lrc',
      UNDECLARED,
      'Pop/Ignoto - Copiato.lrc',
      ROOT_SONG,
    ]) {
      expect(count(path), path).toBe(0);
    }
  });

  it('il testo non esce MAI: nessun marcatore nella risposta (né nel JSON del contratto)', async () => {
    store = fullStore();
    const report = await buildFeaturedRightsReport();
    const json = JSON.stringify(AdminFeaturedRightsSchema.parse(report));
    for (const marker of [
      LRC_MARKER,
      TXT_MARKER,
      TAG_MARKER,
      UNDECLARED_MARKER,
      'prima',
      'seconda',
    ]) {
      expect(json).not.toContain(marker);
    }
    // Il contratto rifiuta un campo con le righe, se mai ci finisse per sbaglio.
    const leaked = structuredClone(report);
    const row = leaked.tracks[0];
    if (row) Object.assign(row.lyrics, { lines: [{ timeMs: 0, text: LRC_MARKER }] });
    expect(AdminFeaturedRightsSchema.safeParse(leaked).success).toBe(false);
  });

  it('errore di lettura dell’audio → "error"; file .lrc non usabile → si passa al tag', async () => {
    store = [
      { pathname: NONE_SONG, bytes: plainMp3() },
      { pathname: TAG_SONG, bytes: mp3WithUslt(`${TAG_MARKER} riga`) },
      // .lrc non UTF-8: inutilizzabile, il testo arriva dal tag incorporato.
      { pathname: 'Rock/Band - Inno.lrc', bytes: new Uint8Array([0xff, 0xfe, 0x00]) },
      manifest([
        { file: NONE_SONG, licenza: 'propria', titolare: 'Band', testo: true },
        { file: TAG_SONG, licenza: 'propria', titolare: 'Band', testo: true },
      ]),
    ];
    const base = mocks.get.getMockImplementation();
    mocks.get.mockImplementation(async (path: string, options?: object) => {
      if (path.includes('Strumentale')) throw new Error('storage giù');
      return base?.(path, options);
    });
    const report = await buildFeaturedRightsReport();
    expect(track(report, NONE_SONG).lyrics).toEqual({ status: 'error' });
    expect(track(report, TAG_SONG)).toMatchObject({
      sidecars: { lrc: true, txt: false },
      lyrics: { status: 'embedded', kind: 'plain', lineCount: 1 },
    });
    expect(report.summary.lyricsErrors).toBe(1);
  });

  it('manifest non valido o assente → nessun brano dichiarato, nessun testo cercato', async () => {
    for (const manifestFile of [
      { pathname: 'diritti.json', bytes: text('{ "versione": 1, "brani": [') },
      null,
    ]) {
      clearFeaturedRightsReportCacheForTests();
      mocks.get.mockClear();
      store = fullStore().filter((file) => file.pathname !== 'diritti.json');
      if (manifestFile) store.push(manifestFile);
      const report = await buildFeaturedRightsReport();
      expect(report.manifest.status).toBe(manifestFile ? 'invalid' : 'missing');
      expect(report.summary.declared).toBe(0);
      expect(report.tracks.every((row) => row.lyrics.status === 'not_checked')).toBe(true);
      expect(reads().filter((path) => path !== 'diritti.json')).toEqual([]);
    }
  });
});

describe('buildFeaturedRightsReport: tetto, parallelismo e scadenza dei controlli', () => {
  function manyDeclared(total: number): StoreFile[] {
    const files: StoreFile[] = [];
    const entries: unknown[] = [];
    for (let index = 0; index < total; index += 1) {
      const pathname = `Serie/Band - Brano ${String(index).padStart(2, '0')}.mp3`;
      const day = String(28 - index).padStart(2, '0');
      files.push({
        pathname,
        bytes: mp3WithUslt(`${TAG_MARKER} ${index}`),
        uploadedAt: `2026-10-${day}T00:00:00Z`,
      });
      entries.push({ file: pathname, licenza: 'propria', titolare: 'Band', testo: true });
    }
    return [...files, manifest(entries)];
  }

  it('oltre il tetto: "skipped" contati; "Aggiorna" usa la cache e controlla i successivi', async () => {
    store = manyDeclared(5);
    const first = await buildFeaturedRightsReport({ maxChecks: 2 });
    expect(first.tracks.map((row) => row.lyrics.status)).toEqual([
      'embedded',
      'embedded',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(first.summary.lyricsSkipped).toBe(3);
    expect(first.summary.lyricsFound).toBe(2);
    expect(vi.mocked(parseBuffer)).toHaveBeenCalledTimes(2);

    const second = await buildFeaturedRightsReport({ maxChecks: 2 });
    expect(second.tracks.map((row) => row.lyrics.status)).toEqual([
      'embedded',
      'embedded',
      'embedded',
      'embedded',
      'skipped',
    ]);
    expect(second.summary.lyricsSkipped).toBe(1);
    // I primi due dalla cache: nessuna nuova lettura.
    expect(vi.mocked(parseBuffer)).toHaveBeenCalledTimes(4);
  });

  it('valori predefiniti: 50 controlli, 3 alla volta', async () => {
    expect(REPORT_MAX_LYRICS_CHECKS).toBe(50);
    expect(REPORT_LYRICS_CONCURRENCY).toBe(3);
    store = manyDeclared(7);
    let active = 0;
    let peak = 0;
    const base = mocks.get.getMockImplementation();
    mocks.get.mockImplementation(async (path: string, options?: object) => {
      if (!path.startsWith('Serie/')) return base?.(path, options);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return base?.(path, options);
    });
    const report = await buildFeaturedRightsReport();
    expect(peak).toBe(3);
    expect(report.summary.lyricsFound).toBe(7);
    expect(report.summary.lyricsSkipped).toBe(0);
  });

  it('oltre il tempo massimo: i controlli in corso risultano "skipped" e poi finiscono in cache', async () => {
    store = manyDeclared(2);
    const base = mocks.get.getMockImplementation();
    mocks.get.mockImplementation(async (path: string, options?: object) => {
      if (path.startsWith('Serie/')) await new Promise((resolve) => setTimeout(resolve, 120));
      return base?.(path, options);
    });
    const report = await buildFeaturedRightsReport({ deadlineMs: 20 });
    // Con la scadenza ignorata i due controlli (120 ms) finirebbero: qui risultano da fare.
    expect(report.tracks.map((row) => row.lyrics.status)).toEqual(['skipped', 'skipped']);
    expect(report.summary.lyricsSkipped).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = await buildFeaturedRightsReport({ deadlineMs: 20 });
    expect(later.summary.lyricsFound).toBe(2);
    expect(later.summary.lyricsSkipped).toBe(0);
  });
});

describe('buildFeaturedRightsReport: elenco dello store e cache', () => {
  it('UN elenco per richiesta, riusato ~60 secondi; diritti.json riletto ogni volta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    store = fullStore();
    await buildFeaturedRightsReport();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(count('diritti.json')).toBe(1);

    await Promise.all([buildFeaturedRightsReport(), buildFeaturedRightsReport()]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(count('diritti.json')).toBe(3);

    vi.setSystemTime(new Date('2026-11-14T10:01:01Z'));
    const fresh = await buildFeaturedRightsReport();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(fresh.store.listedAt).toBe('2026-11-14T10:01:01.000Z');
  });

  it('richieste concorrenti a cache fredda: un solo elenco', async () => {
    store = fullStore();
    await Promise.all([
      buildFeaturedRightsReport(),
      buildFeaturedRightsReport(),
      buildFeaturedRightsReport(),
    ]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('la cache dei testi è quella del player: il player non rilegge il .lrc', async () => {
    store = fullStore();
    await buildFeaturedRightsReport();
    expect(count('Cantautori/Autrice - Canzone.lrc')).toBe(1);
    const lyrics = await readFeaturedLyrics(LRC_SONG);
    expect(lyrics?.lines).toHaveLength(2);
    expect(count('Cantautori/Autrice - Canzone.lrc')).toBe(1);
  });

  it('senza token Blob → store e manifest "unavailable", nessun elenco', async () => {
    mocks.token = undefined;
    const report = await buildFeaturedRightsReport();
    expect(AdminFeaturedRightsSchema.parse(report)).toEqual(report);
    expect(report.store).toEqual({
      status: 'unavailable',
      listedAt: null,
      reason: expect.stringContaining('BLOB_READ_WRITE_TOKEN'),
    });
    expect(report.manifest.status).toBe('unavailable');
    expect(report.tracks).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('elenco interrotto: "partial"; se il manifest non è stato visto → "unavailable"', async () => {
    store = fullStore().filter((file) => file.pathname !== 'diritti.json');
    let page = 0;
    mocks.list.mockImplementation(async () => {
      page += 1;
      return page === 1
        ? { blobs: store.map(listed), hasMore: true, cursor: 'c1' }
        : Promise.reject(new Error('storage giù'));
    });
    // Anche la domanda per nome fallisce: non si sa se diritti.json c'è.
    mocks.head.mockRejectedValue(new Error('storage giù'));
    const report = await buildFeaturedRightsReport();
    expect(report.store.status).toBe('partial');
    expect(report.store.reason).toContain('incompleto');
    expect(report.manifest.status).toBe('unavailable');
    expect(report.tracks).toHaveLength(7);
    expect(report.summary.declared).toBe(0);
  });

  it('nessuna rete diretta: tutto passa dallo store', async () => {
    store = fullStore();
    await buildFeaturedRightsReport();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('buildFeaturedRightsReport: casi limite della diagnosi', () => {
  it('più di 250 brani con "testo": true: gli "Aggiorna" finiscono i controlli e poi non rileggono', async () => {
    const total = 260;
    const files: StoreFile[] = [];
    const entries: unknown[] = [];
    for (let index = 0; index < total; index += 1) {
      const stem = `Molti/Band - Brano ${String(index).padStart(3, '0')}`;
      files.push({ pathname: `${stem}.mp3`, bytes: plainMp3() });
      files.push({ pathname: `${stem}.txt`, bytes: text(`${TXT_MARKER} ${index}`) });
      entries.push({ file: `${stem}.mp3`, licenza: 'propria', titolare: 'Band', testo: true });
    }
    store = [...files, manifest(entries)];
    const sidecarReads = () => reads().filter((path) => path.endsWith('.txt')).length;

    const skipped: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const report = await buildFeaturedRightsReport();
      skipped.push(report.summary.lyricsSkipped);
    }
    // 50 controlli nuovi per richiesta, quelli già fatti restano noti (non solo i 200 del player).
    expect(skipped).toEqual([210, 160, 110, 60, 10, 0]);
    expect(sidecarReads()).toBe(total);

    const settled = await buildFeaturedRightsReport();
    expect(settled.summary.lyricsSkipped).toBe(0);
    expect(settled.summary.lyricsFound).toBe(total);
    expect(sidecarReads()).toBe(total);
    expect(JSON.stringify(settled)).not.toContain(TXT_MARKER);
  });

  it('lettura fallita: «Aggiorna» la ricontrolla subito, dopo i brani mai controllati', async () => {
    const FIRST = 'Rock/Band - Primo.mp3';
    const SECOND = 'Rock/Band - Secondo.mp3';
    store = [
      {
        pathname: FIRST,
        bytes: mp3WithUslt(`${TAG_MARKER} a`),
        uploadedAt: '2026-11-02T00:00:00Z',
      },
      {
        pathname: SECOND,
        bytes: mp3WithUslt(`${TAG_MARKER} b`),
        uploadedAt: '2026-11-01T00:00:00Z',
      },
      manifest([
        { file: FIRST, licenza: 'propria', titolare: 'Band', testo: true },
        { file: SECOND, licenza: 'propria', titolare: 'Band', testo: true },
      ]),
    ];
    const base = mocks.get.getMockImplementation();
    let broken = true;
    mocks.get.mockImplementation(async (path: string, options?: object) => {
      if (broken && path.includes('Primo')) throw new Error('storage giù');
      return base?.(path, options);
    });

    const first = await buildFeaturedRightsReport({ maxChecks: 1 });
    expect(first.tracks.map((row) => row.lyrics.status)).toEqual(['error', 'skipped']);

    broken = false;
    // Un solo controllo: prima il brano mai controllato; quello fallito resta "error" (non "skipped").
    const second = await buildFeaturedRightsReport({ maxChecks: 1 });
    expect(second.tracks.map((row) => row.lyrics.status)).toEqual(['error', 'embedded']);

    const third = await buildFeaturedRightsReport({ maxChecks: 1 });
    expect(third.tracks.map((row) => row.lyrics.status)).toEqual(['embedded', 'embedded']);
    expect(count(FIRST)).toBe(2);
    expect(count(SECOND)).toBe(1);
  });

  it('lettura del .lrc fallita ≠ .lrc inutilizzabile: "sidecarError" solo nel primo caso', async () => {
    store = [
      { pathname: TAG_SONG, bytes: mp3WithUslt(`${TAG_MARKER} riga`) },
      { pathname: 'Rock/Band - Inno.lrc', bytes: text(`[00:01.00]${LRC_MARKER}`) },
      { pathname: NONE_SONG, bytes: mp3WithUslt(`${TAG_MARKER} altra`) },
      { pathname: 'Rock/Band - Strumentale.lrc', bytes: new Uint8Array([0xff, 0xfe, 0x00]) },
      manifest([
        { file: TAG_SONG, licenza: 'propria', titolare: 'Band', testo: true },
        { file: NONE_SONG, licenza: 'propria', titolare: 'Band', testo: true },
      ]),
    ];
    const base = mocks.get.getMockImplementation();
    mocks.get.mockImplementation(async (path: string, options?: object) => {
      if (path.endsWith('Inno.lrc')) throw new Error('rete giù');
      return base?.(path, options);
    });
    const report = await buildFeaturedRightsReport();
    expect(track(report, TAG_SONG).lyrics).toEqual({
      status: 'embedded',
      kind: 'plain',
      lineCount: 1,
      sidecarError: true,
    });
    expect(track(report, NONE_SONG).lyrics).toEqual({
      status: 'embedded',
      kind: 'plain',
      lineCount: 1,
    });
    expect(AdminFeaturedRightsSchema.parse(report)).toEqual(report);
  });

  it('testo spento da un doppione: la riga indica la voce che lo spegne', async () => {
    store = [
      { pathname: LRC_SONG, bytes: plainMp3() },
      { pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: text(`[00:01.00]${LRC_MARKER}`) },
      { pathname: TXT_SONG, bytes: plainMp3() },
      manifest([
        { file: LRC_SONG, licenza: 'propria', titolare: 'Autrice', testo: true },
        { file: TXT_SONG, licenza: 'propria', titolare: 'Autrice' },
        { file: LRC_SONG, licenza: 'propria', titolare: 'Autrice' },
      ]),
    ];
    const report = await buildFeaturedRightsReport();
    expect(track(report, LRC_SONG)).toMatchObject({
      declared: true,
      testo: false,
      testoOffBy: 3,
      lyrics: { status: 'not_checked' },
    });
    expect(track(report, TXT_SONG)).toMatchObject({ testo: false, testoOffBy: null });
    expect(count('Cantautori/Autrice - Canzone.lrc')).toBe(0);
  });

  it('oltre i 5000 brani mostrati: quelli con "testo": true esclusi sono contati a parte', async () => {
    const files: StoreFile[] = [];
    const newest = Date.parse('2026-10-28T00:00:00Z');
    for (let index = 0; index < 5002; index += 1) {
      // Un minuto più vecchio a ogni indice: gli ultimi due sono i meno recenti (esclusi).
      files.push({
        pathname: `Tanti/Brano ${index}.mp3`,
        bytes: text('x'),
        uploadedAt: new Date(newest - index * 60_000).toISOString(),
      });
    }
    store = [
      ...files,
      manifest([
        { file: 'Tanti/Brano 5000.mp3', licenza: 'propria', titolare: 'Band', testo: true },
        { file: 'Tanti/Brano 5001.mp3', licenza: 'propria', titolare: 'Band', testo: true },
      ]),
    ];
    const report = await buildFeaturedRightsReport();
    expect(report.tracks).toHaveLength(5000);
    expect(report.tracksTruncated).toBe(true);
    expect(report.summary).toMatchObject({
      totalTracks: 5002,
      declared: 2,
      declaredWithLyrics: 2,
      lyricsFound: 0,
      lyricsSkipped: 0,
      lyricsNotShown: 2,
    });
    expect(reads().filter((path) => path !== 'diritti.json')).toEqual([]);
  });
});

describe('buildFeaturedRightsReport: diritti.json chiesto per nome', () => {
  const OK_ENTRY = { file: LRC_SONG, licenza: 'propria', titolare: 'Autrice' };

  it('caricato dopo l’elenco in cache: vale subito, senza un nuovo elenco', async () => {
    store = [{ pathname: LRC_SONG, bytes: plainMp3() }];
    const before = await buildFeaturedRightsReport();
    expect(before.manifest.status).toBe('missing');

    store.push(manifest([OK_ENTRY]));
    const after = await buildFeaturedRightsReport();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(after.manifest.status).toBe('valid');
    expect(track(after, LRC_SONG).declared).toBe(true);
    expect(mocks.head).toHaveBeenCalledWith(
      'diritti.json',
      expect.objectContaining({ token: 'tok_test' }),
    );
  });

  it('ridotto sotto 256 KB dopo l’elenco: si legge la dimensione nuova', async () => {
    store = [
      { pathname: LRC_SONG, bytes: plainMp3() },
      { pathname: 'diritti.json', bytes: text(' '.repeat(300 * 1024)) },
    ];
    const before = await buildFeaturedRightsReport();
    expect(before.manifest.reasons[0]).toContain('supera 256 KB');

    store = [{ pathname: LRC_SONG, bytes: plainMp3() }, manifest([OK_ENTRY])];
    const after = await buildFeaturedRightsReport();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(after.manifest.status).toBe('valid');
  });

  it('manifest presente nell’elenco: nessuna domanda per nome', async () => {
    store = fullStore();
    await buildFeaturedRightsReport();
    expect(mocks.head).not.toHaveBeenCalled();
  });

  it('elenco interrotto ma lo store conferma che non c’è → "missing"', async () => {
    store = fullStore().filter((file) => file.pathname !== 'diritti.json');
    mocks.list.mockImplementation(async () => Promise.reject(new Error('storage giù')));
    const report = await buildFeaturedRightsReport();
    expect(report.manifest.status).toBe('missing');
  });
});
