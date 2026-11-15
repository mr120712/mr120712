// @polsia:user-owned — POST /api/music/featured/tracks/<shareId>/download: «Scarica offline» di un
// brano in evidenza. Login e same-origin; 404 identico per id malformati, inventati e brani non
// dichiarati; 403 per un brano dichiarato senza copia offline; permesso ricontrollato su
// diritti.json a OGNI richiesta (revoca immediata); tetto di 50 MB; header dei metadati con
// l'attribuzione; no-store e noindex; download contato (prenotazione non rimborsata) SOLO a corpo
// letto per intero. Più l'attribuzione delle copie e la lettura dell'audio dallo store.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  sameOrigin: vi.fn(() => true),
  requireAuth: vi.fn(),
  consume: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consume,
  releaseRateLimit: mocks.release,
  rateLimitResponse: (bucket: string) =>
    Response.json(
      { error: 'rate_limited', message: `Hai raggiunto il limite per ${bucket}.` },
      { status: 429, headers: { 'Retry-After': '60' } },
    ),
  enforceRateLimit: vi.fn(async () => null),
  getRateLimitIdentity: vi.fn(() => 'user:u1'),
}));

import { POST } from '@/app/api/music/featured/tracks/[shareId]/download/route';
import { OFFLINE_DOWNLOAD_META_HEADER, OfflineDownloadMetaSchema } from '@/lib/contracts/offline';
import { readLocalLyrics } from '@/lib/local-music/lyrics';
import {
  featuredDownloadMime,
  featuredOfflineAttribution,
  isFeaturedAudioType,
  readFeaturedAudio,
} from '@/lib/music/featured-offline.server';
import {
  stripEmbeddedLyrics,
  withoutEmbeddedLyrics,
} from '@/lib/music/featured-offline-lyrics.server';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';
import { featuredShareId } from '@/lib/music/featured-share.server';
import { MAX_DOWNLOAD_BYTES } from '@/lib/music/offline-download.server';

const SECRET = 'segreto-di-prova-abbastanza-lungo';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt: string, size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

const OWN = 'Cantautori/Autrice - Mia.mp3';
const CC = 'Cantautori/Band - Aperta.mp3';
const LICENSED = 'Cantautori/Autrice - Su licenza.mp3';
const UNDECLARED = 'Download/Artista - Copiata.mp3';
const BIG = 'Cantautori/Autrice - Lunghissima.flac';
let store = [
  blob(OWN, '2026-10-05T00:00:00.000Z', 3),
  blob(CC, '2026-10-04T00:00:00.000Z', 3),
  blob(LICENSED, '2026-10-03T00:00:00.000Z', 3),
  blob(UNDECLARED, '2026-10-06T00:00:00.000Z', 3),
  blob(BIG, '2026-10-02T00:00:00.000Z', MAX_DOWNLOAD_BYTES + 1),
  blob('diritti.json', '2026-10-07T00:00:00.000Z', 300),
];
const BASE_STORE = store;

type Row = Record<string, unknown>;
const ROWS: Row[] = [
  { file: OWN, licenza: 'propria', titolare: 'Autrice' },
  {
    file: CC,
    licenza: 'cc-by',
    titolare: 'Band',
    prova: 'https://creativecommons.org/licenses/by/3.0/',
  },
  { file: LICENSED, licenza: 'licenza', titolare: 'Etichetta Srl' },
  { file: BIG, licenza: 'propria', titolare: 'Autrice' },
];
let manifestText = '';
const setManifest = (rows: Row[]) => {
  manifestText = JSON.stringify({ versione: 1, brani: rows });
};

/** Audio servito dallo store per pathname (tipo e corpo configurabili). */
let audio: { type: string; bytes: Uint8Array; length?: string; fail?: boolean } = {
  type: 'audio/mpeg',
  bytes: new Uint8Array([1, 2, 3]),
};

function storeGet(pathname: string) {
  const name = decodeURIComponent(pathname);
  if (name === 'diritti.json') {
    return {
      statusCode: 200,
      stream: new Response(manifestText).body,
      headers: new Headers(),
      blob: { pathname: name, contentType: 'application/json', size: manifestText.length },
    };
  }
  if (audio.fail) throw new Error('rete');
  const headers = new Headers();
  headers.set('content-length', audio.length ?? String(audio.bytes.byteLength));
  return {
    statusCode: 200,
    stream: new Response(audio.bytes).body,
    headers,
    blob: { pathname: name, contentType: audio.type, size: audio.bytes.byteLength },
  };
}

const id = (pathname: string) => featuredShareId(pathname, SECRET);

// File audio con il testo incorporato (gli stessi formati che legge la Libreria).
const encoder = new TextEncoder();
const utf8 = (value: string) => [...encoder.encode(value)];
const latin1 = (value: string) => [...value].map((char) => char.charCodeAt(0) & 0xff);
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
const MP3_AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x64, ...new Array(60).fill(7)]);
function mp3WithLyrics(text: string): Uint8Array {
  const uslt = [3, ...latin1('ita'), 0, ...utf8(text)];
  const frames = [
    ...latin1('TIT2'),
    ...be32(6),
    0,
    0,
    3,
    ...utf8('Titol'),
    ...latin1('USLT'),
    ...be32(uslt.length),
    0,
    0,
    ...uslt,
  ];
  return new Uint8Array([
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    ...syncsafe(frames.length),
    ...frames,
    ...MP3_AUDIO,
  ]);
}
function box(type: number[] | string, payload: number[]): number[] {
  const typeBytes = typeof type === 'string' ? latin1(type) : type;
  return [...be32(8 + payload.length), ...typeBytes, ...payload];
}
function m4aWithLyrics(text: string): Uint8Array {
  const lyr = box([0xa9, 0x6c, 0x79, 0x72], box('data', [...be32(1), ...be32(0), ...utf8(text)]));
  const nam = box([0xa9, 0x6e, 0x61, 0x6d], box('data', [...be32(1), ...be32(0), ...utf8('Mia')]));
  const meta = box('meta', [
    ...be32(0),
    ...box('hdlr', new Array(25).fill(0)),
    ...box('ilst', [...nam, ...lyr]),
  ]);
  return new Uint8Array([
    ...box('ftyp', latin1('M4A isom')),
    ...box('moov', box('udta', meta)),
    ...box('mdat', new Array(200).fill(9)),
  ]);
}
function flacBlock(type: number, body: number[], last = false): number[] {
  const n = body.length;
  return [(last ? 0x80 : 0) | type, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, ...body];
}
function flacWithLyrics(text: string): Uint8Array {
  const comments = ['TITLE=Mia', `LYRICS=${text}`].map(utf8);
  const vorbis = [
    ...le32(4),
    ...utf8('test'),
    ...le32(comments.length),
    ...comments.flatMap((bytes) => [...le32(bytes.length), ...bytes]),
  ];
  return new Uint8Array([
    ...latin1('fLaC'),
    ...flacBlock(0, new Array(34).fill(0)),
    ...flacBlock(6, new Array(40).fill(1)),
    ...flacBlock(4, vorbis, true),
    ...new Array(100).fill(5),
  ]);
}

function call(shareId: string) {
  return POST(
    new Request(`https://solco.test/api/music/featured/tracks/${shareId}/download`, {
      method: 'POST',
      headers: { origin: 'https://solco.test' },
    }),
    { params: Promise.resolve({ shareId }) },
  );
}

function decodeMeta(response: Response) {
  const header = response.headers.get(OFFLINE_DOWNLOAD_META_HEADER) ?? '';
  return OfflineDownloadMetaSchema.parse(
    JSON.parse(Buffer.from(header, 'base64').toString('utf8')),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  for (const mock of [mocks.list, mocks.get, mocks.sameOrigin, mocks.requireAuth]) {
    mock.mockReset();
  }
  mocks.consume.mockReset();
  mocks.release.mockReset();
  mocks.token = 'tok_test';
  store = BASE_STORE;
  mocks.list.mockImplementation(async () => ({ blobs: store, hasMore: false }));
  mocks.get.mockImplementation(async (pathname: string) => storeGet(pathname));
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue({ id: 'u1', emailVerified: true });
  mocks.consume.mockResolvedValue({ allowed: true });
  mocks.release.mockResolvedValue(undefined);
  audio = { type: 'audio/mpeg', bytes: new Uint8Array([1, 2, 3]) };
  setManifest(ROWS);
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/music/featured/tracks/<shareId>/download', () => {
  it('rifiuta una richiesta non same-origin prima di tutto', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await call(id(OWN));
    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('401 senza accesso: nessun limite toccato, nessuna lettura', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await call(id(OWN));
    expect(response.status).toBe(401);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404 identico per id malformato, inventato, non dichiarato (anche con l’id "giusto")', async () => {
    const bodies: unknown[] = [];
    for (const shareId of ['../diritti.json', 'Z'.repeat(22), id(UNDECLARED)]) {
      const response = await call(shareId);
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: 'track_not_found', message: 'Brano non trovato.' });
    // Mai letto l'audio di un file non dichiarato.
    const audioReads = mocks.get.mock.calls.filter(
      ([pathname]) => decodeURIComponent(String(pathname)) !== 'diritti.json',
    );
    expect(audioReads).toEqual([]);
    // Un id inventato o non dichiarato ha prenotato e poi rimborsato (mai contato).
    expect(mocks.release).toHaveBeenCalledTimes(4);
  });

  it('403 con il motivo per un brano dichiarato senza copia offline', async () => {
    const response = await call(id(LICENSED));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('offline_not_allowed');
    expect(body.message).toContain('solo in streaming');
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('200: byte, metadati con attribuzione, no-store e noindex; contato senza rimborso', async () => {
    const response = await call(id(OWN));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    const meta = decodeMeta(response);
    expect(meta).toEqual({
      source: 'featured-download',
      downloadKey: `featured:${id(OWN)}`,
      title: 'Mia',
      artist: 'Autrice',
      album: null,
      durationSeconds: null,
      mimeType: 'audio/mpeg',
      attribution: {
        sourceName: 'Solco · In evidenza',
        sourceUrl: null,
        licenseName: null,
        licenseUrl: null,
        creditLine: '© Autrice',
      },
    });
    // Nessun percorso dello store nei metadati.
    expect(JSON.stringify(meta)).not.toContain('Cantautori/');
    expect(mocks.consume).toHaveBeenCalledWith('music.download', 'user:u1');
    expect(mocks.consume).toHaveBeenCalledWith('music.download.global', 'global');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('Creative Commons: titolare, nome della licenza e link (la versione dichiarata in "prova")', async () => {
    const meta = decodeMeta(await call(id(CC)));
    expect(meta.attribution).toEqual({
      sourceName: 'Solco · In evidenza',
      sourceUrl: null,
      licenseName: 'Creative Commons Attribuzione (CC BY)',
      licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
      creditLine: '© Band',
    });
  });

  it('429 dal limite giornaliero: nessuna lettura dello store', async () => {
    mocks.consume.mockResolvedValueOnce({ allowed: false });
    const response = await call(id(OWN));
    expect(response.status).toBe(429);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('413 oltre 50 MB (dall’elenco): rimborsato, nessun byte letto', async () => {
    const response = await call(id(BIG));
    expect(response.status).toBe(413);
    expect((await response.json()).message).toContain('50 MB');
    expect(mocks.release).toHaveBeenCalledTimes(2);
    const audioReads = mocks.get.mock.calls.filter(
      ([pathname]) => decodeURIComponent(String(pathname)) !== 'diritti.json',
    );
    expect(audioReads).toEqual([]);
  });

  it('download interrotto o non audio: 502 e rimborso (mai contato)', async () => {
    audio = { ...audio, fail: true };
    expect((await call(id(OWN))).status).toBe(502);
    expect(mocks.release).toHaveBeenCalledTimes(2);
    audio = { type: 'text/html', bytes: new Uint8Array([60, 104]) };
    expect((await call(id(OWN))).status).toBe(502);
    expect(mocks.release).toHaveBeenCalledTimes(4);
  });

  it('revoca: il permesso si ricontrolla a ogni richiesta, anche con l’indice in cache', async () => {
    expect((await call(id(OWN))).status).toBe(200);
    setManifest([{ ...ROWS[0], offline: false }, ...ROWS.slice(1)]);
    const revoked = await call(id(OWN));
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).message).toBe(
      'Il titolare non ha concesso la copia offline: questo brano si ascolta solo in streaming.',
    );
    setManifest(ROWS.slice(1));
    expect((await call(id(OWN))).status).toBe(404);
  });

  it('senza "testo": true la copia NON porta il testo incorporato (tag tolti e riverificati)', async () => {
    audio = { type: 'audio/mpeg', bytes: mp3WithLyrics('Riga del testo') };
    const response = await call(id(OWN));
    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    // Il tag ID3 (con il testo) è tolto: restano i byte audio.
    expect(body).toEqual(MP3_AUDIO);
    expect(response.headers.get('content-length')).toBe(String(MP3_AUDIO.byteLength));
    expect(await readLocalLyrics(new Blob([body]))).toBeNull();
    expect(new TextDecoder().decode(body)).not.toContain('Riga del testo');
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('con "testo": true il file resta com’è', async () => {
    setManifest([{ ...ROWS[0], testo: true }, ...ROWS.slice(1)]);
    const original = mp3WithLyrics('Riga del testo');
    audio = { type: 'audio/mpeg', bytes: original };
    const response = await call(id(OWN));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
  });

  it('testo che non si riesce a togliere: 403 solo streaming, rimborsato (mai contato)', async () => {
    // Un tag ID3 che dichiara di coprire tutto il file: nessun audio da salvare senza il testo.
    const frame = [
      ...latin1('USLT'),
      ...be32(30),
      0,
      0,
      3,
      ...latin1('ita'),
      0,
      ...utf8('x'.repeat(25)),
    ];
    audio = {
      type: 'audio/mpeg',
      bytes: new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(frame.length), ...frame]),
    };
    const response = await call(id(OWN));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('offline_not_allowed');
    expect(body.message).toContain('solo in streaming');
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('store non configurato: 503 prima di prenotare', async () => {
    mocks.token = undefined;
    const response = await call(id(OWN));
    expect(response.status).toBe(503);
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});

describe('withoutEmbeddedLyrics: nessun testo incorporato nella copia', () => {
  it('file senza testo: gli stessi byte (nessuna copia)', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 1, 2, 3]);
    const result = await withoutEmbeddedLyrics(bytes);
    expect(result.ok && result.bytes).toBe(bytes);
  });

  it('MP3, M4A e FLAC: il testo sparisce, l’audio resta (M4A/FLAC stessa lunghezza)', async () => {
    for (const original of [
      mp3WithLyrics('Verso segreto'),
      m4aWithLyrics('Verso segreto'),
      flacWithLyrics('Verso segreto'),
    ]) {
      expect(await readLocalLyrics(new Blob([original]))).not.toBeNull();
      const result = await withoutEmbeddedLyrics(original);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(await readLocalLyrics(new Blob([result.bytes]))).toBeNull();
      expect(new TextDecoder().decode(result.bytes)).not.toContain('Verso segreto');
      // L'originale non si tocca.
      expect(new TextDecoder().decode(original)).toContain('Verso segreto');
    }
    const m4a = m4aWithLyrics('Verso segreto');
    expect(stripEmbeddedLyrics(m4a)?.byteLength).toBe(m4a.byteLength);
    // Gli altri tag M4A (il titolo) restano; l'audio è intatto.
    const strippedM4a = stripEmbeddedLyrics(m4a) as Uint8Array;
    expect(new TextDecoder().decode(strippedM4a)).toContain('Mia');
    expect(strippedM4a.slice(-200)).toEqual(m4a.slice(-200));
    const flac = flacWithLyrics('Verso segreto');
    const strippedFlac = stripEmbeddedLyrics(flac) as Uint8Array;
    expect(strippedFlac.byteLength).toBe(flac.byteLength);
    expect(strippedFlac.slice(-100)).toEqual(flac.slice(-100));
  });

  it('MP3 con FLAC dentro dopo il tag ID3: tolti entrambi i testi', async () => {
    const flac = flacWithLyrics('Dentro');
    const id3 = mp3WithLyrics('Fuori').slice(0, -MP3_AUDIO.byteLength);
    const both = new Uint8Array([...id3, ...flac]);
    const result = await withoutEmbeddedLyrics(both);
    expect(result.ok && (await readLocalLyrics(new Blob([result.bytes])))).toBeNull();
  });
});

describe('featuredOfflineAttribution', () => {
  it('propria e licenza: solo il titolare', () => {
    expect(featuredOfflineAttribution({ licenza: 'licenza', titolare: 'Etichetta' })).toMatchObject(
      { creditLine: '© Etichetta', licenseName: null, licenseUrl: null },
    );
  });

  it('CC0 e CC: nome e link della licenza; "prova" usata solo se è la stessa licenza su CC', () => {
    expect(featuredOfflineAttribution({ licenza: 'cc0', titolare: 'Autore' })).toEqual({
      sourceName: 'Solco · In evidenza',
      sourceUrl: null,
      licenseName: 'CC0 1.0 Universale (pubblico dominio)',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/deed.it',
      creditLine: 'Opera di Autore',
    });
    const deed = (prova?: string) =>
      featuredOfflineAttribution({ licenza: 'cc-by-sa', titolare: 'Band', prova }).licenseUrl;
    expect(deed()).toBe('https://creativecommons.org/licenses/by-sa/4.0/deed.it');
    expect(deed('https://creativecommons.org/licenses/by-sa/2.5/it/')).toBe(
      'https://creativecommons.org/licenses/by-sa/2.5/it/',
    );
    // Licenza diversa, host diverso, non https o non un indirizzo: si usa la 4.0.
    for (const prova of [
      'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      'https://example.com/licenses/by-sa/4.0/',
      'http://creativecommons.org/licenses/by-sa/4.0/',
      'Contratto n. 4',
    ]) {
      expect(deed(prova)).toBe('https://creativecommons.org/licenses/by-sa/4.0/deed.it');
    }
  });
});

describe('readFeaturedAudio: lettura dallo store, tipo e tetto', () => {
  const target = { pathname: OWN, public: false, size: 3 };

  it('legge l’intero file con il token, come file privato', async () => {
    const result = await readFeaturedAudio('tok', target);
    expect(result).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    expect(mocks.get).toHaveBeenCalledWith(
      'Cantautori/Autrice%20-%20Mia.mp3',
      expect.objectContaining({ access: 'private', token: 'tok' }),
    );
  });

  it('too_large dall’header o leggendo oltre il tetto', async () => {
    audio = { type: 'audio/mpeg', bytes: new Uint8Array(10), length: '999999999' };
    expect(await readFeaturedAudio('tok', { ...target, size: null })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    audio = { type: 'audio/mpeg', bytes: new Uint8Array(10), length: '0' };
    expect(await readFeaturedAudio('tok', { ...target, size: null }, 5)).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('rifiuta tipi che non possono essere audio e percorsi non audio', async () => {
    audio = { type: 'text/html', bytes: new Uint8Array([1]) };
    expect(await readFeaturedAudio('tok', target)).toEqual({ ok: false, reason: 'not_audio' });
    expect(await readFeaturedAudio('tok', { ...target, pathname: 'diritti.json' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(isFeaturedAudioType('application/octet-stream', OWN)).toBe(true);
    expect(isFeaturedAudioType('image/png', OWN)).toBe(false);
    expect(featuredDownloadMime(null, 'x/Brano.flac')).toBe('audio/flac');
    expect(featuredDownloadMime('audio/ogg; codecs=opus', 'x/Brano.opus')).toBe('audio/ogg');
  });
});
