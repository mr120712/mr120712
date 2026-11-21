// @polsia:user-owned — POST /api/admin/featured-rights/transcribe con la cache CIFRATA: la prima
// trascrizione si conserva cifrata (nessun testo né percorso nei dati scritti) e torna con
// fromCache: false; la seconda torna dalla cache (fromCache: true, cachedAt) senza leggere l'audio,
// senza OpenAI e senza consumare limiti; «regenerate» la rifà e la sostituisce; il permesso vale
// anche per una trascrizione conservata (revoca → 404); file sostituito (etag) o lingua diversa →
// nuova trascrizione; voce o metadati manomessi → rifatta; senza segreto o con il database giù
// tutto funziona come prima; due richieste identiche contemporanee (anche due «Rigenera», o una
// lettura della cache di un attimo prima del salvataggio) → una sola chiamata a OpenAI; dopo una
// lunga attesa senza tempo per rifarla → rifiuto subito, senza limiti né lettura dell'audio.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  put: vi.fn(),
  consume: vi.fn(),
  release: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({
  prisma: {
    lyricsTranscriptionCache: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
      deleteMany: mocks.deleteMany,
    },
  },
}));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', NEXT_PUBLIC_APP_URL: 'https://solco.test' },
}));
vi.mock('@vercel/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob')>()),
  list: mocks.list,
  get: mocks.get,
  head: mocks.head,
  put: mocks.put,
}));
vi.mock('@/lib/business/rate-limit.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/rate-limit.server')>()),
  consumeRateLimit: mocks.consume,
  releaseRateLimit: mocks.release,
}));

import { BlobNotFoundError } from '@vercel/blob';
import { POST as transcribe } from '@/app/api/admin/featured-rights/transcribe/route';
import { TranscribeResponseSchema } from '@/lib/contracts/lyrics-transcription';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';
import { audioVersionOf } from '@/lib/music/lyrics-transcription.server';
import { clearTranscriptionCacheForTests } from '@/lib/music/transcription-cache.server';

const ORIGIN = 'https://solco.test';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const SECRET = 'segreto-di-prova-0123456789abcdef-0123456789';
const KEY = 'sk-test-CHIAVE-71c2';
const admin = { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true };
const encoder = new TextEncoder();
const TRANSCRIBE = '/api/admin/featured-rights/transcribe';

const SONG = 'Cantautori/Autrice - Canzone.mp3';
const OTHER = 'Cantautori/Autrice - Ballata.mp3';
const UNDECLARED = 'Pop/Ignoto - Copiato.mp3';
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 9, 9, 9]);
const DRAFT = '[00:12.30] Prima strofa\n[00:20.00] Ritornello';

type StoreFile = { pathname: string; bytes: Uint8Array; etag?: string };

type Row = {
  id: string;
  keyHash: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
  model: string;
  language: string | null;
  durationSeconds: number | null;
  lineCount: number;
  droppedSegments: number;
  createdAt: Date;
  lastUsedAt: Date;
};

const entries = [
  { file: SONG, licenza: 'propria', titolare: 'Autrice', testo: true },
  { file: OTHER, licenza: 'propria', titolare: 'Autrice', testo: true },
];

function manifest(list: Array<Record<string, unknown>>): StoreFile {
  return {
    pathname: 'diritti.json',
    bytes: encoder.encode(JSON.stringify({ versione: 1, brani: list })),
  };
}

function fullStore(): StoreFile[] {
  return [
    { pathname: SONG, bytes: AUDIO, etag: '"v1"' },
    { pathname: OTHER, bytes: AUDIO, etag: '"b1"' },
    { pathname: UNDECLARED, bytes: AUDIO },
    manifest(entries),
  ];
}

let store: StoreFile[] = [];
let rows: Row[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let warns: MockInstance<typeof console.warn>;
let whisperText = ' Prima strofa';

function blobUrl(file: StoreFile) {
  return `${PRIVATE}/${file.pathname.split('/').map(encodeURIComponent).join('/')}`;
}

function streamOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function whisperBody() {
  return {
    language: 'italian',
    duration: 184.37,
    text: 'testo',
    segments: [
      { start: 12.3, end: 15, text: whisperText, avg_logprob: -0.2, no_speech_prob: 0.01 },
      { start: 20, end: 22, text: ' Ritornello', avg_logprob: -0.2, no_speech_prob: 0.01 },
    ],
  };
}

function post(body: unknown, signal?: AbortSignal) {
  return new Request(`${ORIGIN}${TRANSCRIBE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'better-auth.session_token=fake',
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function call(body: unknown, signal?: AbortSignal) {
  const response = await transcribe(post(body, signal));
  return { response, body: await response.json() };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function installFakeDb() {
  let next = 0;
  mocks.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) => {
    const row = rows.find((candidate) => candidate.keyHash === where.keyHash);
    return row ? { ...row } : null;
  });
  mocks.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { keyHash: string; createdAt?: { lte: Date } };
      create: Omit<Row, 'id'>;
      update: Partial<Row>;
    }) => {
      const index = rows.findIndex((row) => row.keyHash === where.keyHash);
      if (index >= 0) {
        const current = rows[index] as Row;
        if (where.createdAt && !(current.createdAt <= where.createdAt.lte)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        rows[index] = { ...current, ...update };
        return { id: current.id };
      }
      next += 1;
      rows.push({ id: `row-${next}`, ...create } as Row);
      return { id: `row-${next}` };
    },
  );
  mocks.updateMany.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      rows = rows.map((row) => (row.id === where.id ? { ...row, ...data } : row));
      return { count: 1 };
    },
  );
  mocks.deleteMany.mockImplementation(
    async ({ where }: { where: { id: string; iv: Uint8Array } }) => {
      const before = rows.length;
      rows = rows.filter((row) => !(row.id === where.id && sameBytes(row.iv, where.iv)));
      return { count: before - rows.length };
    },
  );
}

/** Tutti i testi di un payload, con i byte letti come testo in più codifiche. */
function textsOf(value: unknown): string[] {
  if (value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    return [buffer.toString('utf8'), buffer.toString('latin1'), buffer.toString('utf16le')];
  }
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...textsOf(inner)]);
  }
  return [];
}

function audioReads() {
  return mocks.get.mock.calls
    .map(([path]) => String(path).split('/').map(decodeURIComponent).join('/'))
    .filter((pathname) => pathname !== 'diritti.json');
}

beforeEach(() => {
  vi.resetAllMocks();
  clearTranscriptionCacheForTests();
  clearFeaturedSearchCacheForTests();
  vi.stubEnv('GROQ_API_KEY', KEY);
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = fullStore();
  rows = [];
  whisperText = ' Prima strofa';
  installFakeDb();
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.consume.mockResolvedValue({ allowed: true });
  mocks.release.mockResolvedValue(undefined);
  mocks.list.mockImplementation(async () => ({
    blobs: store.map((file) => ({
      pathname: file.pathname,
      url: blobUrl(file),
      downloadUrl: '',
      size: file.bytes.length,
      uploadedAt: new Date('2026-11-01T00:00:00Z'),
    })),
    hasMore: false,
  }));
  mocks.head.mockImplementation(async (pathname: string) => {
    const file = store.find((candidate) => candidate.pathname === pathname);
    if (!file) throw new BlobNotFoundError();
    return {
      pathname: file.pathname,
      url: blobUrl(file),
      downloadUrl: '',
      size: file.bytes.length,
      contentType: 'audio/mpeg',
      contentDisposition: '',
      cacheControl: '',
      uploadedAt: new Date('2026-11-01T00:00:00Z'),
      etag: file.etag ?? '',
    };
  });
  mocks.get.mockImplementation(async (path: string) => {
    const pathname = path.split('/').map(decodeURIComponent).join('/');
    const file = store.find((candidate) => candidate.pathname === pathname);
    if (!file) return null;
    return {
      statusCode: 200,
      stream: streamOf(file.bytes),
      headers: new Headers({ 'content-length': String(file.bytes.length) }),
    };
  });
  fetchMock = vi.fn(async () => Response.json(whisperBody()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('prima trascrizione: conservata cifrata', () => {
  it('fromCache false, cachedAt ISO; nessun testo né percorso nei dati scritti o nei log', async () => {
    const { response, body } = await call({ pathname: SONG });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const parsed = TranscribeResponseSchema.parse(body);
    expect(parsed).toMatchObject({ draft: DRAFT, lineCount: 2, fromCache: false });
    expect(parsed.cachedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(parsed.cachedAt ?? ''))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const payload = mocks.upsert.mock.calls[0]?.[0];
    const texts = textsOf(payload).join('\n');
    for (const secret of ['Prima strofa', 'Ritornello', SONG, 'Autrice', 'Canzone', 'Cantautori']) {
      expect(texts).not.toContain(secret);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.iv).toHaveLength(12);
    expect(rows[0]?.authTag).toHaveLength(16);
    expect(JSON.stringify(warns.mock.calls)).not.toContain('Prima strofa');
  });

  it('una trascrizione fallita (errore di OpenAI) non si conserva', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({}, { status: 500 }));
    const { response } = await call({ pathname: SONG });
    expect(response.status).toBe(502);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });
});

describe('seconda richiesta: dalla cache', () => {
  it('fromCache true e cachedAt, senza leggere l’audio, senza OpenAI e senza limiti', async () => {
    const first = await call({ pathname: SONG });
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: admin });

    const { response, body } = await call({ pathname: SONG });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(TranscribeResponseSchema.parse(body)).toEqual({
      draft: DRAFT,
      engine: 'Solco AI (Groq · whisper-large-v3)',
      lineCount: 2,
      language: 'italian',
      durationSeconds: 184.4,
      droppedSegments: 0,
      uncertainLines: [],
      wordTimed: false,
      fromCache: true,
      cachedAt: first.body.cachedAt,
    });
    expect(audioReads()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    // Il permesso si è comunque ricontrollato adesso (elenco, diritti.json, head).
    expect(mocks.list).toHaveBeenCalled();
    expect(mocks.head).toHaveBeenCalledWith(SONG, expect.anything());
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: rows[0]?.id },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('permesso revocato ("testo" tolto o voce rimossa) → 404 anche con la trascrizione conservata', async () => {
    await call({ pathname: SONG });
    expect(rows).toHaveLength(1);
    const referenceBody = await (await transcribe(post({ pathname: UNDECLARED }))).text();
    for (const revoked of [
      entries.map((entry) => (entry.file === SONG ? { ...entry, testo: false } : entry)),
      entries.filter((entry) => entry.file !== SONG),
    ]) {
      store = [
        ...fullStore().filter((file) => file.pathname !== 'diritti.json'),
        manifest(revoked),
      ];
      mocks.findUnique.mockClear();
      const response = await transcribe(post({ pathname: SONG }));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(referenceBody);
      // La cache non si consulta nemmeno: prima viene il permesso.
      expect(mocks.findUnique).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('file audio sostituito (etag diverso) → nuova trascrizione e nuova voce', async () => {
    await call({ pathname: SONG });
    store = store.map((file) => (file.pathname === SONG ? { ...file, etag: '"v2"' } : file));
    whisperText = ' Strofa nuova';
    const { body } = await call({ pathname: SONG });
    expect(body.fromCache).toBe(false);
    expect(body.draft).toContain('Strofa nuova');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.keyHash)).size).toBe(2);
  });

  it('versione dell’audio: etag, altrimenti dimensione + data di caricamento', () => {
    const uploadedAt = new Date('2026-11-01T00:00:00Z');
    expect(audioVersionOf({ etag: '"abc"', size: 10, uploadedAt })).toBe('etag:"abc"');
    expect(audioVersionOf({ etag: '', size: 10, uploadedAt })).toBe(
      'size:10:2026-11-01T00:00:00.000Z',
    );
    expect(audioVersionOf({ etag: '', size: 11, uploadedAt })).not.toBe(
      audioVersionOf({ etag: '', size: 10, uploadedAt }),
    );
  });

  it('lingua diversa o altro brano → chiavi diverse, ognuna pagata una volta sola', async () => {
    await call({ pathname: SONG });
    await call({ pathname: SONG, language: 'it' });
    await call({ pathname: OTHER });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(rows.map((row) => row.keyHash)).size).toBe(3);
    for (const body of [
      { pathname: SONG },
      { pathname: SONG, language: 'it' },
      { pathname: OTHER },
    ]) {
      expect((await call(body)).body.fromCache).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('voce manomessa → trascritta di nuovo e sostituita', async () => {
    await call({ pathname: SONG });
    const row = rows[0] as Row;
    const tag = new Uint8Array(row.authTag);
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    row.authTag = tag;
    const { body } = await call({ pathname: SONG });
    expect(body.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect((await call({ pathname: SONG })).body.fromCache).toBe(true);
  });

  it('metadati cambiati nel database (righe, lingua, durata, segmenti) → mai mostrati: trascritta di nuovo', async () => {
    await call({ pathname: SONG });
    Object.assign(rows[0] as Row, {
      lineCount: 999,
      language: 'english',
      durationSeconds: 1,
      droppedSegments: 42,
    });
    const { response, body } = await call({ pathname: SONG });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      fromCache: false,
      lineCount: 2,
      language: 'italian',
      durationSeconds: 184.4,
      droppedSegments: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe('«Rigenera con l’IA» (regenerate: true)', () => {
  it('ignora la voce conservata, consuma i limiti, chiama OpenAI e la sostituisce', async () => {
    const first = await call({ pathname: SONG });
    const firstIv = rows[0]?.iv as Uint8Array;
    mocks.consume.mockClear();
    mocks.findUnique.mockClear();
    whisperText = ' Strofa rigenerata';
    const { response, body } = await call({ pathname: SONG, regenerate: true });
    expect(response.status).toBe(200);
    expect(body.fromCache).toBe(false);
    expect(body.draft).toContain('Strofa rigenerata');
    expect(body.cachedAt).not.toBe(null);
    expect(Date.parse(body.cachedAt)).toBeGreaterThanOrEqual(Date.parse(first.body.cachedAt));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.consume.mock.calls).toEqual([
      ['lyrics.transcribe', 'user:admin-1'],
      ['lyrics.transcribe.global', 'global'],
    ]);
    // Nessuna lettura della voce vecchia: la rigenerazione non la usa.
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(sameBytes(rows[0]?.iv as Uint8Array, firstIv)).toBe(false);

    const again = await call({ pathname: SONG });
    expect(again.body).toMatchObject({ fromCache: true });
    expect(again.body.draft).toContain('Strofa rigenerata');
  });

  it('regenerate non booleano o campi in più → 400 senza OpenAI', async () => {
    for (const body of [
      { pathname: SONG, regenerate: 'sì' },
      { pathname: SONG, regenerate: true, force: true },
    ]) {
      expect((await call(body)).response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rigenerazione sul brano non ammesso → lo stesso 404', async () => {
    const { response } = await call({ pathname: UNDECLARED, regenerate: true });
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});

describe('cache spenta o non disponibile', () => {
  it('senza BETTER_AUTH_SECRET: nessun accesso al database, trascrizione come prima', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    for (let index = 0; index < 2; index += 1) {
      const { response, body } = await call({ pathname: SONG });
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ fromCache: false, cachedAt: null });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const fn of [mocks.findUnique, mocks.upsert, mocks.updateMany, mocks.deleteMany]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('database giù: la bozza arriva lo stesso, non conservata (cachedAt null)', async () => {
    mocks.findUnique.mockRejectedValue(new Error('db giù'));
    mocks.upsert.mockRejectedValue(new Error('db giù'));
    const { response, body } = await call({ pathname: SONG });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ draft: DRAFT, fromCache: false, cachedAt: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('richieste identiche contemporanee', () => {
  function heldWhisper() {
    let respond: () => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          respond = () => resolve(Response.json(whisperBody()));
        }),
    );
    return () => respond();
  }

  it('la seconda aspetta la prima e riusa la sua trascrizione: OpenAI chiamato una volta', async () => {
    const respond = heldWhisper();
    const first = transcribe(post({ pathname: SONG }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = transcribe(post({ pathname: SONG }));
    // La seconda arriva fino all'attesa senza chiamare OpenAI né consumare limiti.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledTimes(2);
    respond();
    const [a, b] = await Promise.all([first, second]);
    expect((await a.json()).fromCache).toBe(false);
    expect((await b.json()).fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledTimes(2);
  });

  it('se la prima fallisce, la seconda trascrive da sé', async () => {
    let fail: () => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          fail = () => resolve(Response.json({}, { status: 500 }));
        }),
    );
    const first = transcribe(post({ pathname: SONG }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = transcribe(post({ pathname: SONG }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fail();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(502);
    expect(b.status).toBe(200);
    expect((await b.json()).fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('annullata mentre aspetta → 499, nessun limite consumato da lei', async () => {
    const respond = heldWhisper();
    const first = transcribe(post({ pathname: SONG }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const second = transcribe(post({ pathname: SONG }, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const cancelled = await second;
    expect(cancelled.status).toBe(499);
    expect(mocks.consume).toHaveBeenCalledTimes(2);
    respond();
    expect((await first).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dopo una lunga attesa dietro una trascrizione fallita: rifiuto subito, senza limiti né lettura dell’audio', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    let fail: () => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          fail = () => resolve(Response.json({}, { status: 500 }));
        }),
    );
    const first = transcribe(post({ pathname: SONG }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = transcribe(post({ pathname: SONG }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.consume).toHaveBeenCalledTimes(2);
    expect(audioReads()).toHaveLength(1);
    // La prima resta da OpenAI per 100 s, poi fallisce: alla seconda non resta il tempo.
    offset = 100_000;
    fail();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(502);
    expect(b.status).toBe(503);
    const body = await b.json();
    expect(body.error).toBe('transcription_retry');
    expect(body.message).toContain('Un’altra trascrizione dello stesso brano');
    expect(body.message).not.toContain('store');
    // Nessun limite consumato e nessuna lettura dell'audio da parte della seconda.
    expect(mocks.consume).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(audioReads()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prima lettura della cache di un attimo prima che l’identica salvasse: si riguarda, OpenAI una volta', async () => {
    const respond = heldWhisper();
    const b = transcribe(post({ pathname: SONG }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // La lettura di A parte ora ma "vede" il database di prima del salvataggio di B.
    let answerStale: () => void = () => undefined;
    mocks.findUnique.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStale = () => resolve(null);
        }),
    );
    const a = transcribe(post({ pathname: SONG }));
    // B: prima lettura + rilettura dopo essersi segnata in corso; A: la sua prima lettura (ferma).
    await vi.waitFor(() => expect(mocks.findUnique).toHaveBeenCalledTimes(3));
    respond();
    expect((await (await b).json()).fromCache).toBe(false);
    expect(rows).toHaveLength(1);
    answerStale();
    const body = await (await a).json();
    expect(body).toMatchObject({ fromCache: true, draft: DRAFT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledTimes(2);
  });

  it('due «Rigenera» identiche contemporanee: OpenAI pagato una volta sola', async () => {
    const first = await call({ pathname: SONG });
    whisperText = ' Strofa rigenerata';
    const respond = heldWhisper();
    const a = transcribe(post({ pathname: SONG, regenerate: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const b = transcribe(post({ pathname: SONG, regenerate: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    respond();
    const [bodyA, bodyB] = await Promise.all([(await a).json(), (await b).json()]);
    expect(bodyA.fromCache).toBe(false);
    expect(bodyA.draft).toContain('Strofa rigenerata');
    // La seconda riceve la trascrizione NUOVA (scritta dopo la sua richiesta), non quella vecchia.
    expect(bodyB).toMatchObject({ fromCache: true, draft: bodyA.draft, cachedAt: bodyA.cachedAt });
    expect(bodyB.cachedAt).not.toBe(first.body.cachedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.consume).toHaveBeenCalledTimes(4);
  });

  it('«Rigenera» durante una trascrizione identica in corso: riusa quella appena pagata', async () => {
    const respond = heldWhisper();
    const miss = transcribe(post({ pathname: SONG }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const regenerate = transcribe(post({ pathname: SONG, regenerate: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    respond();
    const [a, b] = await Promise.all([(await miss).json(), (await regenerate).json()]);
    expect(a.fromCache).toBe(false);
    expect(b).toMatchObject({ fromCache: true, draft: a.draft, cachedAt: a.cachedAt });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledTimes(2);
  });

  it('«Rigenera» dietro una trascrizione che fallisce: ignora la voce vecchia e la rifà da sé', async () => {
    await call({ pathname: SONG });
    let fail: () => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          fail = () => resolve(Response.json({}, { status: 500 }));
        }),
    );
    const a = transcribe(post({ pathname: SONG, regenerate: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    whisperText = ' Strofa rigenerata';
    const b = transcribe(post({ pathname: SONG, regenerate: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fail();
    const [first, second] = await Promise.all([a, b]);
    expect(first.status).toBe(502);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.fromCache).toBe(false);
    expect(body.draft).toContain('Strofa rigenerata');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
