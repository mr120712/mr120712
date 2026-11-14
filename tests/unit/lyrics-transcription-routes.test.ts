// @polsia:user-owned — route della trascrizione IA dei testi (POST /api/admin/featured-rights/
// transcribe e …/transcribe/save): stessa origine e admin verificato su entrambe; il permesso si
// ricontrolla ADESSO (brano non dichiarato, "testo" false, file assente o percorso non valido →
// lo stesso 404, nessuna chiamata a OpenAI, nessun limite consumato; una revoca vale subito);
// chiave mancante; formati e dimensioni rifiutati; limiti per admin e globali consumati solo se la
// chiamata parte; richiesta a OpenAI con l'audio letto dallo store; errori senza dettagli né
// chiave; salvataggio validato, nome del .lrc ricavato dal pathname, 409 senza conferma, opzioni
// di put, cache del testo svuotata; e i campi della diagnosi admin (`transcriptionAvailable`,
// `transcription` solo per i brani con "testo": true).
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
  invalidate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
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
vi.mock('@/lib/music/featured-lyrics.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/music/featured-lyrics.server')>();
  return {
    ...actual,
    invalidateFeaturedLyricsCache: (pathname: string) => {
      mocks.invalidate(pathname);
      actual.invalidateFeaturedLyricsCache(pathname);
    },
  };
});

import {
  BlobAccessError,
  BlobError,
  BlobNotFoundError,
  BlobPreconditionFailedError,
} from '@vercel/blob';
import { GET as getReport } from '@/app/api/admin/featured-rights/route';
import { POST as transcribe } from '@/app/api/admin/featured-rights/transcribe/route';
import { POST as save } from '@/app/api/admin/featured-rights/transcribe/save/route';
import { clearFeaturedRightsReportCacheForTests } from '@/lib/admin/featured-rights-report.server';
import { AdminFeaturedRightsSchema } from '@/lib/contracts/admin-featured-rights';
import {
  SaveLyricsResponseSchema,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import { clearFeaturedLyricsCacheForTests } from '@/lib/music/featured-lyrics.server';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';

const ORIGIN = 'https://solco.test';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const PUBLIC = 'https://store.public.blob.vercel-storage.com';
const KEY = 'sk-test-CHIAVE-SEGRETA-71c2';
const UPSTREAM_DETAIL = `Incorrect API key provided: ${KEY}. Request id req_123`;
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };
const encoder = new TextEncoder();

const SONG = 'Cantautori/Autrice - Canzone.mp3';
const PUBLIC_SONG = 'Pubblici/Autrice - Aperta.m4a';
const NO_TESTO = 'Rock/Band - Inno.mp3';
const UNDECLARED = 'Pop/Ignoto - Copiato.mp3';
const OPUS = 'Voce/Autrice - Sussurro.opus';
const HUGE = 'Grande/Autrice - Lunga.wav';
const GHOST = 'Fantasma/Autrice - Assente.mp3';
const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 9, 9, 9]);

type StoreFile = { pathname: string; bytes: Uint8Array; size?: number; public?: boolean };

function manifest(entries: Array<Record<string, unknown>>) {
  return {
    pathname: 'diritti.json',
    bytes: encoder.encode(JSON.stringify({ versione: 1, brani: entries })),
  };
}

const declaredEntries = [
  { file: SONG, licenza: 'propria', titolare: 'Autrice', testo: true },
  { file: PUBLIC_SONG, licenza: 'propria', titolare: 'Autrice', testo: true },
  { file: NO_TESTO, licenza: 'propria', titolare: 'Band', testo: false },
  { file: OPUS, licenza: 'propria', titolare: 'Autrice', testo: true },
  { file: HUGE, licenza: 'propria', titolare: 'Autrice', testo: true },
  { file: GHOST, licenza: 'propria', titolare: 'Autrice', testo: true },
];

function fullStore(): StoreFile[] {
  return [
    { pathname: SONG, bytes: AUDIO },
    { pathname: PUBLIC_SONG, bytes: AUDIO, public: true },
    { pathname: NO_TESTO, bytes: AUDIO },
    { pathname: UNDECLARED, bytes: AUDIO },
    { pathname: OPUS, bytes: AUDIO },
    { pathname: HUGE, bytes: AUDIO, size: 26_000_000 },
    manifest(declaredEntries),
  ];
}

let store: StoreFile[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
let errors: MockInstance<typeof console.error>;

function blobUrl(file: StoreFile) {
  return `${file.public ? PUBLIC : PRIVATE}/${file.pathname.split('/').map(encodeURIComponent).join('/')}`;
}

function find(pathname: string) {
  return store.find((file) => file.pathname === pathname);
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
    task: 'transcribe',
    language: 'italian',
    duration: 184.37,
    text: 'testo',
    segments: [
      {
        id: 0,
        start: 0.2,
        end: 3,
        text: ' Sottotitoli a cura di QTSS',
        avg_logprob: -0.4,
        no_speech_prob: 0.1,
        compression_ratio: 1,
      },
      {
        id: 1,
        start: 12.3,
        end: 15,
        text: ' Prima strofa',
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        compression_ratio: 1.1,
      },
      {
        id: 2,
        start: 20,
        end: 22,
        text: ' Ritornello',
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        compression_ratio: 1.1,
      },
      {
        id: 3,
        start: 28,
        end: 30,
        text: ' Ritornello',
        avg_logprob: -0.2,
        no_speech_prob: 0.01,
        compression_ratio: 1.1,
      },
      {
        id: 4,
        start: 31,
        end: 33,
        text: ' ...',
        avg_logprob: -1.7,
        no_speech_prob: 0.92,
        compression_ratio: 0.6,
      },
    ],
  };
}

function post(path: string, body: unknown, origin: string | null = ORIGIN, signal?: AbortSignal) {
  const headers = new Headers({
    'content-type': 'application/json',
    cookie: 'better-auth.session_token=fake',
  });
  if (origin) headers.set('origin', origin);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

const TRANSCRIBE = '/api/admin/featured-rights/transcribe';
const SAVE = '/api/admin/featured-rights/transcribe/save';
const allowed = { allowed: true } as const;

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('OPENAI_API_KEY', KEY);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearFeaturedRightsReportCacheForTests();
  clearFeaturedSearchCacheForTests();
  clearFeaturedLyricsCacheForTests();
  store = fullStore();
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.consume.mockResolvedValue(allowed);
  mocks.release.mockResolvedValue(undefined);
  mocks.list.mockImplementation(async () => ({
    blobs: store.map((file) => ({
      pathname: file.pathname,
      url: blobUrl(file),
      downloadUrl: '',
      size: file.size ?? file.bytes.length,
      uploadedAt: new Date('2026-11-01T00:00:00Z'),
    })),
    hasMore: false,
  }));
  mocks.head.mockImplementation(async (pathname: string) => {
    const file = find(pathname);
    if (!file) throw new BlobNotFoundError();
    return {
      pathname: file.pathname,
      url: blobUrl(file),
      downloadUrl: '',
      size: file.size ?? file.bytes.length,
      contentType: 'application/octet-stream',
      contentDisposition: '',
      cacheControl: '',
      uploadedAt: new Date('2026-11-01T00:00:00Z'),
      etag: `"etag-${file.pathname}"`,
    };
  });
  mocks.get.mockImplementation(async (path: string) => {
    const file = find(path.split('/').map(decodeURIComponent).join('/'));
    if (!file) return null;
    return {
      statusCode: 200,
      stream: streamOf(file.bytes),
      headers: new Headers({ 'content-length': String(file.bytes.length) }),
      blob: { size: file.bytes.length },
    };
  });
  mocks.put.mockImplementation(async (pathname: string) => ({
    pathname,
    url: `${PRIVATE}/${pathname}`,
    downloadUrl: '',
    contentType: 'text/plain; charset=utf-8',
    contentDisposition: '',
  }));
  fetchMock = vi.fn(async () => Response.json(whisperBody()));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function audioReads() {
  return mocks.get.mock.calls
    .map(([path]) => String(path).split('/').map(decodeURIComponent).join('/'))
    .filter((pathname) => pathname !== 'diritti.json');
}

describe('accesso: stessa origine e admin verificato', () => {
  for (const [label, path, call, body] of [
    ['bozza', TRANSCRIBE, transcribe, { pathname: SONG }],
    ['salvataggio', SAVE, save, { pathname: SONG, lrc: '[00:01.00] Uno', overwrite: false }],
  ] as const) {
    it(`${label}: 403 senza Origin o con un'altra origine, senza leggere la sessione`, async () => {
      for (const origin of [null, 'https://evil.test']) {
        const response = await call(post(path, body, origin));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'forbidden_origin' });
      }
      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.put).not.toHaveBeenCalled();
    });

    it(`${label}: 401 senza sessione, 403 non admin o email non verificata, 503 sessione giù`, async () => {
      mocks.getSession.mockResolvedValueOnce(null);
      const anonymous = await call(post(path, body));
      expect(anonymous.status).toBe(401);
      expectPrivate(anonymous);
      for (const user of [
        { id: 'u1', role: 'user', emailVerified: true },
        { ...admin, emailVerified: false },
      ]) {
        mocks.getSession.mockResolvedValueOnce({ user });
        const response = await call(post(path, body));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'forbidden' });
      }
      mocks.getSession.mockRejectedValueOnce(new Error('db giù'));
      expect((await call(post(path, body))).status).toBe(503);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.consume).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.put).not.toHaveBeenCalled();
    });
  }
});

describe('bozza: permesso ricontrollato adesso', () => {
  it('non dichiarato, "testo" false, file assente, percorso non valido → stesso 404, niente OpenAI', async () => {
    const bodies: string[] = [];
    for (const pathname of [
      UNDECLARED,
      NO_TESTO,
      GHOST,
      '../diritti.json',
      'Cantautori/../Cantautori/Autrice - Canzone.mp3',
      '/Cantautori/Autrice - Canzone.mp3',
      'public-uploads/utente.mp3',
      'diritti.json',
      'Cantautori/Autrice - Canzone.lrc',
      '',
    ]) {
      const response = await transcribe(post(TRANSCRIBE, { pathname }));
      expect(response.status, pathname).toBe(404);
      expectPrivate(response);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      error: 'not_found',
      message: expect.stringContaining('"testo": true'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(audioReads()).toEqual([]);
  });

  it('manifest assente o non valido → stesso 404', async () => {
    store = fullStore().filter((file) => file.pathname !== 'diritti.json');
    const missing = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    store = [
      ...fullStore().filter((file) => file.pathname !== 'diritti.json'),
      {
        pathname: 'diritti.json',
        bytes: encoder.encode('{ non json'),
      },
    ];
    const invalid = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(404);
    expect(await missing.text()).toBe(await invalid.text());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una revoca ("testo" tolto) vale alla richiesta successiva: nessuna cache', async () => {
    expect((await transcribe(post(TRANSCRIBE, { pathname: SONG }))).status).toBe(200);
    store = [
      ...fullStore().filter((file) => file.pathname !== 'diritti.json'),
      manifest(
        declaredEntries.map((entry) => (entry.file === SONG ? { ...entry, testo: false } : entry)),
      ),
    ];
    const revoked = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(revoked.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Il manifest privato si legge sempre dall'origine.
    const manifestReads = mocks.get.mock.calls.filter(([path]) => path === 'diritti.json');
    expect(manifestReads.length).toBe(2);
    for (const [, options] of manifestReads) expect(options).toMatchObject({ useCache: false });
  });

  it('store o diritti.json non leggibili ora → 503 "riprova", niente OpenAI né limiti', async () => {
    mocks.list.mockRejectedValueOnce(new Error('storage giù'));
    const listing = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(listing.status).toBe(503);
    expect((await listing.json()).error).toBe('store_unavailable');

    const original = mocks.get.getMockImplementation();
    mocks.get.mockImplementation(async (path: string, options: unknown) => {
      if (path === 'diritti.json') throw new Error('rete');
      return original?.(path, options);
    });
    const rights = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(rights.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('chiave OpenAI mancante → 503 col messaggio per Vercel, senza leggere lo store', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({
      error: 'transcription_not_configured',
      message: 'Aggiungi OPENAI_API_KEY su Vercel per usare la trascrizione',
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('corpo non valido o lingua sconosciuta → 400 con errori per campo', async () => {
    const bad = await transcribe(post(TRANSCRIBE, '{ rotto'));
    expect(bad.status).toBe(400);
    const language = await transcribe(post(TRANSCRIBE, { pathname: SONG, language: 'xx' }));
    expect(language.status).toBe(400);
    expect((await language.json()).errors.language).toContain('Lingua non valida');
    const extra = await transcribe(post(TRANSCRIBE, { pathname: SONG, model: 'gpt-4' }));
    expect(extra.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bozza: formato e dimensione', () => {
  it('formato che Whisper non accetta → 415 in italiano, niente OpenAI né limiti', async () => {
    const response = await transcribe(post(TRANSCRIBE, { pathname: OPUS }));
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.error).toBe('unsupported_format');
    expect(body.message).toContain('Formato .opus non supportato');
    expect(body.message).toContain('mp3');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('oltre 25 MB secondo lo store → 413 senza scaricare il file', async () => {
    const response = await transcribe(post(TRANSCRIBE, { pathname: HUGE }));
    expect(response.status).toBe(413);
    expect((await response.json()).message).toContain('al massimo 25 MB');
    expect(audioReads()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('lettura oltre 25 MB (content-length) → 413 e limiti restituiti', async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path === 'diritti.json'
        ? {
            statusCode: 200,
            stream: streamOf(find('diritti.json')?.bytes ?? new Uint8Array()),
            headers: new Headers(),
          }
        : {
            statusCode: 200,
            stream: streamOf(AUDIO),
            headers: new Headers({ 'content-length': '30000000' }),
          },
    );
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('lyrics.transcribe', 'user:admin-1');
    expect(mocks.release).toHaveBeenCalledWith('lyrics.transcribe.global', 'global');
  });

  it('audio illeggibile → 502 e limiti restituiti', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === 'diritti.json') {
        return {
          statusCode: 200,
          stream: streamOf(find('diritti.json')?.bytes ?? new Uint8Array()),
          headers: new Headers(),
        };
      }
      throw new Error('rete');
    });
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});

describe('bozza: limiti e chiamata a OpenAI', () => {
  it('200 privata: bozza LRC, righe, lingua, durata e segmenti scartati', async () => {
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG, language: 'it' }));
    expect(response.status).toBe(200);
    expectPrivate(response);
    const body = TranscribeResponseSchema.parse(await response.json());
    expect(body).toEqual({
      draft: '[00:12.30] Prima strofa\n[00:20.00] Ritornello\n[00:28.00] Ritornello',
      lineCount: 3,
      language: 'italian',
      durationSeconds: 184.4,
      droppedSegments: 2,
    });
    expect(mocks.consume.mock.calls).toEqual([
      ['lyrics.transcribe', 'user:admin-1'],
      ['lyrics.transcribe.global', 'global'],
    ]);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("l'audio letto dallo store (privato con il token) va a OpenAI col nome neutro", async () => {
    await transcribe(post(TRANSCRIBE, { pathname: SONG, language: 'en' }));
    expect(mocks.get).toHaveBeenCalledWith(
      'Cantautori/Autrice%20-%20Canzone.mp3',
      expect.objectContaining({ access: 'private', token: 'tok_test' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['segment']);
    expect(form.get('language')).toBe('en');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.mp3');
    expect(file.name).not.toContain('Autrice');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO);
  });

  it('audio pubblico: letto con accesso public; lingua automatica senza campo', async () => {
    const response = await transcribe(post(TRANSCRIBE, { pathname: PUBLIC_SONG }));
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(
      'Pubblici/Autrice%20-%20Aperta.m4a',
      expect.objectContaining({ access: 'public' }),
    );
    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.has('language')).toBe(false);
    expect((form.get('file') as File).name).toBe('audio.m4a');
  });

  it('limite per admin superato → 429, niente OpenAI e niente limite globale', async () => {
    mocks.consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 1200,
      status: 429,
      error: 'rate_limited',
      message: 'x',
    });
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1200');
    expect((await response.json()).message).toBe(
      'Hai raggiunto il limite per le trascrizioni dei testi con l’IA. Riprova tra 1200 secondi.',
    );
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audioReads()).toEqual([]);
  });

  it('tetto globale superato → 429, il limite dell’admin si restituisce', async () => {
    mocks.consume.mockResolvedValueOnce(allowed).mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 3600,
      status: 429,
      error: 'rate_limited',
      message: 'x',
    });
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(response.status).toBe(429);
    expect((await response.json()).message).toContain('di oggi');
    expect(mocks.release).toHaveBeenCalledWith('lyrics.transcribe', 'user:admin-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errori di OpenAI: messaggi italiani, mai il testo della risposta né la chiave', async () => {
    const cases: Array<[() => Promise<Response>, number, string]> = [
      [
        async () => Response.json({ error: { message: UPSTREAM_DETAIL } }, { status: 401 }),
        502,
        'chiave OpenAI non valida',
      ],
      [
        async () => Response.json({ error: { message: UPSTREAM_DETAIL } }, { status: 429 }),
        429,
        'limite OpenAI raggiunto, riprova più tardi',
      ],
      [
        async () => Response.json({ error: { message: UPSTREAM_DETAIL } }, { status: 413 }),
        413,
        'file troppo grande',
      ],
      [
        async () => Response.json({ error: { message: UPSTREAM_DETAIL } }, { status: 500 }),
        502,
        'OpenAI ha un problema',
      ],
      [async () => Promise.reject(new TypeError(UPSTREAM_DETAIL)), 502, 'OpenAI non risponde'],
    ];
    for (const [respond, status, text] of cases) {
      fetchMock.mockImplementationOnce(respond);
      const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
      expect(response.status).toBe(status);
      expectPrivate(response);
      const raw = await response.text();
      expect(JSON.parse(raw).message).toContain(text);
      expect(raw).not.toContain(KEY);
      expect(raw).not.toContain('req_123');
      expect(raw).not.toContain('Incorrect API key');
    }
    // Una chiamata partita conta: nessun rimborso.
    expect(mocks.release).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY);
  });

  it('annullata mentre si legge l’audio → niente OpenAI, lettura interrotta, limiti restituiti', async () => {
    const original = mocks.get.getMockImplementation();
    for (const readFails of [true, false]) {
      vi.clearAllMocks();
      mocks.consume.mockResolvedValue(allowed);
      const controller = new AbortController();
      let readSignalAborted: boolean | undefined;
      mocks.get.mockImplementation(async (path: string, options: { abortSignal?: AbortSignal }) => {
        if (path === 'diritti.json') return original?.(path, options);
        // L'admin preme «Annulla» durante la lettura (fino a 30 s per 25 MB).
        controller.abort();
        // La lettura dallo store riceve l'interruzione della richiesta.
        readSignalAborted = options.abortSignal?.aborted;
        if (readFails) throw new DOMException('This operation was aborted', 'AbortError');
        return original?.(path, options);
      });
      const response = await transcribe(
        post(TRANSCRIBE, { pathname: SONG }, ORIGIN, controller.signal),
      );
      expect(readSignalAborted).toBe(true);
      expect(response.status).toBe(499);
      expect((await response.json()).error).toBe('cancelled');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.consume).toHaveBeenCalledTimes(2);
      expect(mocks.release.mock.calls).toEqual([
        ['lyrics.transcribe', 'user:admin-1'],
        ['lyrics.transcribe.global', 'global'],
      ]);
    }
  });

  it('OpenAI irraggiungibile prima dell’invio (DNS) → 502 e limiti restituiti', async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), {
          code: 'ENOTFOUND',
        }),
      }),
    );
    const response = await transcribe(post(TRANSCRIBE, { pathname: SONG }));
    expect(response.status).toBe(502);
    const raw = await response.text();
    expect(JSON.parse(raw).message).toContain('OpenAI non risponde');
    expect(raw).not.toContain('getaddrinfo');
    expect(mocks.release).toHaveBeenCalledWith('lyrics.transcribe', 'user:admin-1');
    expect(mocks.release).toHaveBeenCalledWith('lyrics.transcribe.global', 'global');
  });
});

describe('diritti.json pubblico', () => {
  it('bozza e salvataggio rifiutati per ogni brano: il CDN potrebbe servire una revoca vecchia', async () => {
    store = fullStore().map((file) =>
      file.pathname === 'diritti.json' ? { ...file, public: true } : file,
    );
    const bodies: string[] = [];
    for (const pathname of [SONG, PUBLIC_SONG, UNDECLARED, NO_TESTO]) {
      const response = await transcribe(post(TRANSCRIBE, { pathname }));
      expect(response.status, pathname).toBe(503);
      expectPrivate(response);
      bodies.push(await response.text());
    }
    const saved = await save(
      post(SAVE, { pathname: SONG, lrc: '[00:01.00] Uno', overwrite: true }),
    );
    expect(saved.status).toBe(503);
    bodies.push(await saved.text());
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      error: 'rights_manifest_public',
      message: expect.stringContaining('va caricato come privato'),
    });
    // Il manifest pubblico non si legge nemmeno; niente OpenAI, limiti o scritture.
    expect(mocks.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe('salvataggio del .lrc', () => {
  const LRC = '[00:12.30] Prima strofa\r\n[00:20.00] Ritornello  ';

  it('nuovo .lrc: stessa cartella e stesso nome, privato come l’audio, cache svuotata', async () => {
    const response = await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }));
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(SaveLyricsResponseSchema.parse(await response.json())).toEqual({
      saved: true,
      visibleWithinMinutes: 5,
    });
    expect(mocks.put).toHaveBeenCalledTimes(1);
    const [target, content, options] = mocks.put.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(target).toBe('Cantautori/Autrice - Canzone.lrc');
    expect(content).toBe('[00:12.30] Prima strofa\n[00:20.00] Ritornello\n');
    expect(options).toMatchObject({
      access: 'private',
      token: 'tok_test',
      contentType: 'text/plain; charset=utf-8',
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(options).not.toHaveProperty('ifMatch');
    expect(mocks.consume).toHaveBeenCalledWith('lyrics.transcribe.save', 'user:admin-1');
    expect(mocks.invalidate).toHaveBeenCalledWith(SONG);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('audio pubblico → .lrc comunque PRIVATO (mai un indirizzo ricavabile da quello pubblico)', async () => {
    const response = await save(post(SAVE, { pathname: PUBLIC_SONG, lrc: LRC, overwrite: false }));
    expect(response.status).toBe(200);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith(
      'Pubblici/Autrice - Aperta.lrc',
      expect.any(String),
      expect.objectContaining({ access: 'private' }),
    );
    expect(mocks.put.mock.calls[0]?.[2]).not.toMatchObject({ access: 'public' });
  });

  it('store che rifiuta i file privati → errore italiano, nessun ripiego pubblico', async () => {
    for (const error of [new BlobAccessError(), new BlobError('Private blobs are not enabled')]) {
      mocks.put.mockRejectedValueOnce(error);
      const response = await save(
        post(SAVE, { pathname: PUBLIC_SONG, lrc: LRC, overwrite: false }),
      );
      expect(response.status).toBe(502);
      expectPrivate(response);
      const body = await response.json();
      expect(body.error).toBe('lrc_private_rejected');
      expect(body.message).toContain('solo come privati');
    }
    expect(mocks.put).toHaveBeenCalledTimes(2);
    for (const call of mocks.put.mock.calls) expect(call[2]).toMatchObject({ access: 'private' });
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('il limite dei salvataggi si consuma solo prima di scrivere: i rifiuti non contano', async () => {
    for (const pathname of [UNDECLARED, NO_TESTO, GHOST, '../x.mp3', 'nope.txt']) {
      const response = await save(post(SAVE, { pathname, lrc: LRC, overwrite: false }));
      expect(response.status, pathname).toBe(404);
    }
    store.push({ pathname: 'Cantautori/Autrice - Canzone.lrc', bytes: encoder.encode('x') });
    expect((await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }))).status).toBe(
      409,
    );
    mocks.head.mockRejectedValueOnce(new Error('rete'));
    expect((await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: true }))).status).toBe(
      503,
    );
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();

    // Scrittura fallita: il salvataggio si restituisce.
    mocks.put.mockRejectedValueOnce(new Error('rete'));
    expect((await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: true }))).status).toBe(
      502,
    );
    expect(mocks.consume.mock.calls).toEqual([['lyrics.transcribe.save', 'user:admin-1']]);
    expect(mocks.release.mock.calls).toEqual([['lyrics.transcribe.save', 'user:admin-1']]);
  });

  it('.lrc già presente senza conferma → 409 per il campo, niente scrittura', async () => {
    store.push({
      pathname: 'Cantautori/Autrice - Canzone.lrc',
      bytes: encoder.encode('[00:01.00] Vecchio'),
    });
    const response = await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'lrc_exists',
      errors: { lrc: 'Esiste già un .lrc: conferma per sostituirlo' },
    });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('.lrc con maiuscole diverse accanto al brano conta come esistente', async () => {
    store.push({ pathname: 'Cantautori/Autrice - Canzone.LRC', bytes: encoder.encode('x') });
    const response = await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }));
    expect(response.status).toBe(409);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('con la conferma sostituisce solo il file visto adesso (allowOverwrite + ifMatch)', async () => {
    store.push({
      pathname: 'Cantautori/Autrice - Canzone.lrc',
      bytes: encoder.encode('[00:01.00] Vecchio'),
    });
    const response = await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: true }));
    expect(response.status).toBe(200);
    expect(mocks.put.mock.calls[0]?.[2]).toMatchObject({
      allowOverwrite: true,
      ifMatch: '"etag-Cantautori/Autrice - Canzone.lrc"',
    });
    expect(mocks.invalidate).toHaveBeenCalledWith(SONG);
  });

  it('file comparso o cambiato nel frattempo → 409; altri errori dello store → 502', async () => {
    mocks.put.mockRejectedValueOnce(new BlobError('This blob already exists'));
    expect((await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }))).status).toBe(
      409,
    );
    mocks.put.mockRejectedValueOnce(new BlobPreconditionFailedError());
    expect((await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: true }))).status).toBe(
      409,
    );
    mocks.put.mockRejectedValueOnce(new Error('rete'));
    const failed = await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }));
    expect(failed.status).toBe(502);
    expect((await failed.json()).message).toContain('Salvataggio non riuscito');
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('testo non valido → 400 per il campo, prima di toccare lo store', async () => {
    for (const [lrc, message] of [
      ['   ', 'Il testo è vuoto'],
      [Array.from({ length: 200 }, () => 'è'.repeat(400)).join('\n'), '64 KB'],
      ['x'.repeat(300_000), '64 KB'],
    ] as const) {
      const response = await save(post(SAVE, { pathname: SONG, lrc, overwrite: false }));
      expect(response.status).toBe(400);
      expect((await response.json()).errors.lrc).toContain(message);
    }
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('il nome del file viene SOLO dal pathname: campi in più rifiutati, ".." → 404', async () => {
    const extra = await save(
      post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false, target: '../diritti.json' }),
    );
    expect(extra.status).toBe(400);
    for (const pathname of [
      '../diritti.json',
      'Cantautori/../diritti.mp3',
      'public-uploads/a.mp3',
    ]) {
      const response = await save(post(SAVE, { pathname, lrc: LRC, overwrite: true }));
      expect(response.status).toBe(404);
    }
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('brani non ammessi → lo stesso 404 della bozza, niente scrittura', async () => {
    const reference = await (await transcribe(post(TRANSCRIBE, { pathname: UNDECLARED }))).text();
    for (const pathname of [UNDECLARED, NO_TESTO, GHOST]) {
      const response = await save(post(SAVE, { pathname, lrc: LRC, overwrite: true }));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(reference);
    }
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('limite dei salvataggi superato → 429, niente scrittura', async () => {
    mocks.consume.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 60,
      status: 429,
      error: 'rate_limited',
      message: 'x',
    });
    const response = await save(post(SAVE, { pathname: SONG, lrc: LRC, overwrite: false }));
    expect(response.status).toBe(429);
    expect((await response.json()).message).toContain('i salvataggi dei testi');
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe('diagnosi admin: campi della trascrizione', () => {
  function reportRequest() {
    return new Request(`${ORIGIN}/api/admin/featured-rights`, {
      headers: { cookie: 'better-auth.session_token=fake' },
    });
  }

  it('`transcription` solo per i brani con "testo": true; `transcriptionAvailable` dalla chiave', async () => {
    const body = AdminFeaturedRightsSchema.parse(await (await getReport(reportRequest())).json());
    expect(body.transcriptionAvailable).toBe(true);
    const flags = Object.fromEntries(body.tracks.map((row) => [row.pathname, row.transcription]));
    expect(flags).toEqual({
      [SONG]: 'ready',
      [PUBLIC_SONG]: 'ready',
      [NO_TESTO]: undefined,
      [UNDECLARED]: undefined,
      [OPUS]: 'unsupported_format',
      // 26 MB secondo l'elenco: pulsante spento prima del clic.
      [HUGE]: 'too_large',
    });

    clearFeaturedRightsReportCacheForTests();
    vi.stubEnv('OPENAI_API_KEY', '');
    const off = AdminFeaturedRightsSchema.parse(await (await getReport(reportRequest())).json());
    expect(off.transcriptionAvailable).toBe(false);
  });
});
