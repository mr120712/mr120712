// @polsia:user-owned — «Carica su audio.com» lato server: contratto (rightsConfirmed proprio true,
// formati, 100 MB, URL di staging), indirizzi che arrivano da audio.com (il token SOLO su
// https://api.audio.com), token di staging su Vercel Blob (solo admin, stessa origine, prefisso,
// formati, 100 MB, suffisso casuale, scadenza; niente cancello della libreria pubblica) e route di
// invio: stessa origine, solo admin, limite orario, URL solo sullo store di Solco, create → PUT →
// success → item/add, `fail` se l'invio non riesce e copia di staging cancellata comunque.
// Collegamento ad audio.com e HTTP finti; client di Vercel Blob vero per il token (nessuna rete).
// @vitest-environment node
import { getPayloadFromClientToken } from '@vercel/blob/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    getSession: vi.fn(),
    sameOrigin: vi.fn(() => true),
    enforceRateLimit: vi.fn(async () => null as Response | null),
    head: vi.fn(),
    del: vi.fn(async () => undefined),
    getAccess: vi.fn(),
    markRejected: vi.fn(async () => undefined),
    listCollections: vi.fn(),
    clearSections: vi.fn(),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
// La libreria pubblica spenta NON deve fermare il caricamento su audio.com.
vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => false }));
vi.mock('@/lib/env', () => ({
  env: {
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_StoreAbc123_segretissimo',
    NEXT_PUBLIC_APP_URL: 'https://solco.test',
  },
}));
vi.mock('@vercel/blob', () => ({
  head: mocks.head,
  del: mocks.del,
  BlobNotFoundError: mocks.BlobNotFoundError,
}));
vi.mock('@/lib/music/audiocom-collections.server', () => ({
  listAudioComCollectionsForAdmin: mocks.listCollections,
  clearAudioComSectionsCache: mocks.clearSections,
}));
vi.mock('@/lib/music/audiocom-connection.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/audiocom-connection.server')>()),
  getAudioComAccessToken: mocks.getAccess,
  markAudioComAccessRejected: mocks.markRejected,
}));

import { POST as stageToken } from '@/app/api/admin/audiocom/uploads/blob/route';
import { POST as upload } from '@/app/api/admin/audiocom/uploads/route';
import {
  AUDIOCOM_UPLOAD_MAX_BYTES,
  AUDIOCOM_UPLOAD_MESSAGES,
  AUDIOCOM_UPLOAD_MIME_TYPES,
  AudioComUploadFormSchema,
  AudioComUploadInputSchema,
  AudioComUploadResponseSchema,
  isAudioComStagingPathname,
  parseAudioComStagingUrl,
} from '@/lib/contracts/audiocom-upload';
import {
  audioComApiHookUrl,
  audioComPresignedUploadUrl,
  audioComStagingStoreHost,
  stagedAudioComBlobUrl,
} from '@/lib/music/audiocom-upload.server';

const ORIGIN = 'https://solco.test';
const STORE_HOST = 'storeabc123.public.blob.vercel-storage.com';
const BLOB_URL = `https://${STORE_HOST}/audiocom-staging/il-mio-brano-AbC123xYz.mp3`;
const BYTES = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 9]);
const AUDIO_ID = '164620711711840702';
const TOKEN = 'acc-SEGRETO-audiocom';
const COLLECTION_ID = '555';

const POLICY = {
  audio: {
    id: AUDIO_ID,
    title: 'Il mio brano',
    slug: 'il-mio-brano',
    username: 'solco',
    license: 'cc-by',
    is_listed: true,
  },
  url: `https://s3.audio.com/upload/${AUDIO_ID}?X-Amz-Signature=firmato`,
  success: `https://api.audio.com/v1/audio/upload/success?id=${AUDIO_ID}`,
  fail: `https://api.audio.com/v1/audio/upload/fail?id=${AUDIO_ID}`,
};

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function admin(id = 'admin-1') {
  return { user: { id, role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true } };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    blobUrl: BLOB_URL,
    name: 'Il mio brano.mp3',
    size: BYTES.byteLength,
    mime: 'audio/mpeg',
    title: 'Il mio brano',
    description: 'Registrato a casa.',
    license: 'cc-by',
    category: 'music',
    isListed: true,
    isDownloadable: false,
    rightsConfirmed: true,
    ...overrides,
  };
}

function uploadRequest(body: unknown) {
  return new Request(`${ORIGIN}/api/admin/audiocom/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

function tokenRequest(body: unknown) {
  return new Request(`${ORIGIN}/api/admin/audiocom/uploads/blob`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

function tokenEvent(pathname = 'audiocom-staging/il-mio-brano.mp3') {
  return {
    type: 'blob.generate-client-token',
    payload: { pathname, clientPayload: null, multipart: false },
  };
}

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** HTTP finto: store Blob, API di audio.com (create, hook, item/add, delete) e PUT firmato. */
function serve(
  overrides: Partial<
    Record<'blob' | 'create' | 'put' | 'success' | 'fail' | 'add' | 'delete', Handler>
  > = {},
  policy: unknown = POLICY,
) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const pick = (name: keyof typeof overrides, fallback: () => Response) =>
      overrides[name] ? overrides[name](init) : fallback();
    if (url.hostname === STORE_HOST) {
      return pick(
        'blob',
        () => new Response(BYTES.slice(), { headers: { 'content-type': 'audio/mpeg' } }),
      );
    }
    if (url.hostname === 'api.audio.com') {
      if (url.pathname === '/v1/audio/create') return pick('create', () => json(policy, 201));
      if (url.pathname === '/v1/audio/upload/success') {
        return pick('success', () => json({ ...POLICY.audio }));
      }
      if (url.pathname === '/v1/audio/upload/fail') {
        return pick('fail', () => new Response(null, { status: 204 }));
      }
      if (url.pathname === '/v1/collection/item/add') {
        return pick('add', () => new Response(null, { status: 204 }));
      }
      if (url.pathname === '/v1/audio/delete') {
        return pick('delete', () => new Response(null, { status: 204 }));
      }
    }
    if (method === 'PUT') return pick('put', () => new Response(null, { status: 200 }));
    return new Response('inatteso', { status: 418 });
  });
}

/** Le richieste HTTP partite, nell'ordine: indirizzo, metodo, Authorization e corpo. */
function calls() {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? 'GET',
    auth: new Headers(init?.headers).get('authorization'),
    contentType: new Headers(init?.headers).get('content-type'),
    body: init?.body,
  }));
}

function step(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname === 'api.audio.com' ? parsed.pathname : parsed.hostname;
}

/** Il token di audio.com non è mai partito verso un host diverso da api.audio.com. */
function expectTokenOnlyToApi() {
  for (const call of calls()) {
    if (call.auth !== null) {
      expect(new URL(call.url).hostname).toBe('api.audio.com');
      expect(new URL(call.url).protocol).toBe('https:');
    }
    expect(JSON.stringify(call.body ?? '')).not.toContain(TOKEN);
  }
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  mocks.getSession.mockReset().mockResolvedValue(admin());
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.head
    .mockReset()
    .mockResolvedValue({ size: BYTES.byteLength, contentType: 'audio/mpeg', pathname: '' });
  mocks.del.mockReset().mockResolvedValue(undefined);
  mocks.getAccess.mockReset().mockResolvedValue({ ok: true, token: TOKEN, version: 3 });
  mocks.markRejected.mockReset();
  mocks.listCollections.mockReset().mockResolvedValue({
    status: 'ok',
    collections: [
      {
        id: COLLECTION_ID,
        title: 'Album',
        type: 'album',
        itemsCount: 1,
        listed: true,
        imageUrl: null,
        featured: false,
      },
    ],
    featuredIds: [],
  });
  mocks.clearSections.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contratto', () => {
  it('un corpo completo è valido; rightsConfirmed deve essere proprio true', () => {
    expect(AudioComUploadInputSchema.safeParse(validBody()).success).toBe(true);
    for (const rightsConfirmed of [false, undefined, 'true', 1]) {
      const parsed = AudioComUploadInputSchema.safeParse(validBody({ rightsConfirmed }));
      expect(parsed.success).toBe(false);
      expect(
        parsed.error?.issues.find((issue) => issue.path[0] === 'rightsConfirmed')?.message,
      ).toBe(AUDIOCOM_UPLOAD_MESSAGES.rights);
    }
  });

  it('formati, dimensione, testi, collection e campi in più', () => {
    const invalid = (overrides: Record<string, unknown>) =>
      AudioComUploadInputSchema.safeParse(validBody(overrides)).success;
    expect(invalid({ mime: 'audio/webm' })).toBe(false);
    expect(invalid({ size: AUDIOCOM_UPLOAD_MAX_BYTES + 1 })).toBe(false);
    expect(invalid({ size: AUDIOCOM_UPLOAD_MAX_BYTES })).toBe(true);
    expect(invalid({ size: 0 })).toBe(false);
    expect(invalid({ size: 1.5 })).toBe(false);
    expect(invalid({ title: '   ' })).toBe(false);
    expect(invalid({ title: 'a'.repeat(201) })).toBe(false);
    expect(invalid({ title: 'riga\u0000nulla' })).toBe(false);
    expect(invalid({ description: 'd'.repeat(501) })).toBe(false);
    expect(invalid({ description: 'Prima riga\nseconda riga' })).toBe(true);
    expect(invalid({ license: 'none' })).toBe(false);
    expect(invalid({ category: 'podcast' })).toBe(false);
    expect(invalid({ collectionId: 'abc' })).toBe(false);
    expect(invalid({ collectionId: COLLECTION_ID })).toBe(true);
    expect(invalid({ extra: true })).toBe(false);
    expect(AUDIOCOM_UPLOAD_MIME_TYPES).toContain('audio/mpeg');
  });

  it('URL di staging: https, Vercel Blob, nel prefisso, senza query né percorsi annidati', () => {
    expect(parseAudioComStagingUrl(BLOB_URL)?.hostname).toBe(STORE_HOST);
    for (const bad of [
      `http://${STORE_HOST}/audiocom-staging/x.mp3`,
      `https://${STORE_HOST}/public-uploads/x.mp3`,
      `https://${STORE_HOST}/audiocom-staging/sub/x.mp3`,
      `https://${STORE_HOST}/audiocom-staging/..%2Fpublic-uploads%2Fx.mp3`,
      `https://${STORE_HOST}/audiocom-staging/x.mp3?download=1`,
      `https://${STORE_HOST}:8443/audiocom-staging/x.mp3`,
      `https://user:pw@${STORE_HOST}/audiocom-staging/x.mp3`,
      'https://evil.example/audiocom-staging/x.mp3',
      'https://public.blob.vercel-storage.com.evil.example/audiocom-staging/x.mp3',
    ]) {
      expect(parseAudioComStagingUrl(bad)).toBeNull();
    }
    expect(isAudioComStagingPathname('audiocom-staging/il-mio-brano.mp3')).toBe(true);
    for (const bad of [
      'audiocom-staging/../x.mp3',
      'audiocom-staging/sub/x.mp3',
      'public-uploads/x.mp3',
      'audiocom-staging/x.exe',
      'audiocom-staging/Maiuscole.mp3',
    ]) {
      expect(isAudioComStagingPathname(bad)).toBe(false);
    }
  });

  it('modulo del client: senza la conferma dei diritti non passa', () => {
    const values = {
      title: 'Brano',
      description: '',
      license: 'arr',
      category: 'music',
      isListed: false,
      isDownloadable: false,
      collectionId: '',
      rightsConfirmed: false,
    };
    const refused = AudioComUploadFormSchema.safeParse(values);
    expect(refused.error?.issues[0]?.path).toEqual(['rightsConfirmed']);
    expect(AudioComUploadFormSchema.safeParse({ ...values, rightsConfirmed: true }).success).toBe(
      true,
    );
  });
});

describe('indirizzi', () => {
  it('lo store di Solco si ricava dal token; un URL di un altro store non vale', () => {
    expect(audioComStagingStoreHost('vercel_blob_rw_StoreAbc123_segreto')).toBe(STORE_HOST);
    expect(audioComStagingStoreHost('')).toBeNull();
    expect(audioComStagingStoreHost('tok_test')).toBeNull();
    expect(stagedAudioComBlobUrl(BLOB_URL)?.toString()).toBe(BLOB_URL);
    expect(
      stagedAudioComBlobUrl(
        'https://altrostore.public.blob.vercel-storage.com/audiocom-staging/x.mp3',
      ),
    ).toBeNull();
  });

  it('hook success/fail: solo https su api.audio.com esatto', () => {
    expect(audioComApiHookUrl(POLICY.success)?.toString()).toBe(POLICY.success);
    expect(audioComApiHookUrl('/v1/audio/upload/success?id=1')?.hostname).toBe('api.audio.com');
    for (const bad of [
      'https://evil.example/v1/audio/upload/success',
      'http://api.audio.com/v1/audio/upload/success',
      'https://api.audio.com.evil.example/x',
      'https://api.audio.com:8443/x',
      'https://user:pw@api.audio.com/x',
      'https://audio.com/x',
      'https://s3.audio.com/x',
      '//evil.example/x',
      '\\\\evil.example/x',
    ]) {
      expect(audioComApiHookUrl(bad)).toBeNull();
    }
  });

  it('URL firmato del PUT: https assoluto su un dominio pubblico', () => {
    expect(audioComPresignedUploadUrl(POLICY.url)?.hostname).toBe('s3.audio.com');
    for (const bad of [
      'http://s3.audio.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://metadata.internal/x',
      'https://s3.audio.com:444/x',
      'https://u:p@s3.audio.com/x',
      '/relativo',
    ]) {
      expect(audioComPresignedUploadUrl(bad)).toBeNull();
    }
  });
});

describe('POST /api/admin/audiocom/uploads/blob (token di staging)', () => {
  it('admin dalla stessa origine: token solo per il prefisso, i formati di audio.com e 100 MB', async () => {
    const response = await stageToken(tokenRequest(tokenEvent()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = (await response.json()) as { type: string; clientToken: string };
    expect(body.type).toBe('blob.generate-client-token');
    const payload = getPayloadFromClientToken(body.clientToken) as unknown as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      pathname: 'audiocom-staging/il-mio-brano.mp3',
      allowedContentTypes: [...AUDIOCOM_UPLOAD_MIME_TYPES],
      maximumSizeInBytes: AUDIOCOM_UPLOAD_MAX_BYTES,
      addRandomSuffix: true,
      allowOverwrite: false,
      ttlDays: 1,
    });
    // Nessuna callback di completamento: ogni richiesta viene dal browser dell'admin.
    expect(payload.onUploadCompleted).toBeUndefined();
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      'audiocom.upload.stage.admin',
      'user:admin-1',
    );
  });

  it('altra origine 403; senza sessione 401; non admin o email non verificata 403', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await stageToken(tokenRequest(tokenEvent()))).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValue(true);
    mocks.getSession.mockResolvedValue(null);
    expect((await stageToken(tokenRequest(tokenEvent()))).status).toBe(401);
    mocks.getSession.mockResolvedValue({ user: { id: 'u1', role: 'user', emailVerified: true } });
    expect((await stageToken(tokenRequest(tokenEvent()))).status).toBe(403);
    mocks.getSession.mockResolvedValue({
      user: { id: 'a2', role: 'admin', emailVerified: false },
    });
    expect((await stageToken(tokenRequest(tokenEvent()))).status).toBe(403);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('percorso fuori dal prefisso o evento diverso dalla richiesta del token: 400', async () => {
    for (const pathname of ['public-uploads/x.mp3', 'audiocom-staging/../x.mp3', 'x.mp3']) {
      expect((await stageToken(tokenRequest(tokenEvent(pathname)))).status).toBe(400);
    }
    const completed = await stageToken(
      tokenRequest({ type: 'blob.upload-completed', payload: { blob: {}, tokenPayload: null } }),
    );
    expect(completed.status).toBe(400);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('oltre il limite orario: la risposta del limite', async () => {
    mocks.enforceRateLimit.mockResolvedValue(new Response('limite', { status: 429 }));
    expect((await stageToken(tokenRequest(tokenEvent()))).status).toBe(429);
  });
});

describe('POST /api/admin/audiocom/uploads', () => {
  it('altra origine: 403 prima di sessione, storage e audio.com', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('senza sessione 401, non admin 403: nessun file letto né cancellato', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await upload(uploadRequest(validBody()))).status).toBe(401);
    mocks.getSession.mockResolvedValue({ user: { id: 'u1', role: 'user', emailVerified: true } });
    expect((await upload(uploadRequest(validBody()))).status).toBe(403);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('senza la conferma dei diritti: 400 sul campo, niente ad audio.com, staging cancellato', async () => {
    for (const rightsConfirmed of [undefined, false]) {
      const response = await upload(uploadRequest(validBody({ rightsConfirmed })));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        errors: { rightsConfirmed: AUDIOCOM_UPLOAD_MESSAGES.rights },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.del).toHaveBeenCalledTimes(2);
    expect(mocks.del).toHaveBeenCalledWith(
      BLOB_URL,
      expect.objectContaining({ token: expect.any(String) }),
    );
  });

  it.each([
    ['un altro host', 'https://evil.example/audiocom-staging/x.mp3'],
    [
      'un altro store Blob',
      'https://altrostore.public.blob.vercel-storage.com/audiocom-staging/x.mp3',
    ],
    ['fuori dal prefisso', `https://${STORE_HOST}/public-uploads/x.mp3`],
    ['http', `http://${STORE_HOST}/audiocom-staging/x.mp3`],
    ['un indirizzo interno', 'https://169.254.169.254/audiocom-staging/x.mp3'],
  ])('blobUrl su %s: 400, mai letto né cancellato', async (_label, blobUrl) => {
    const response = await upload(uploadRequest(validBody({ blobUrl })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { errors: Record<string, string> }).errors.blobUrl).toBe(
      AUDIOCOM_UPLOAD_MESSAGES.blobUrl,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('tutto in regola: create → PUT → success → item/add, 201 e staging cancellato', async () => {
    serve();
    const response = await upload(uploadRequest(validBody({ collectionId: COLLECTION_ID })));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = AudioComUploadResponseSchema.parse(await response.json());
    expect(body).toEqual({
      audio: {
        id: AUDIO_ID,
        title: 'Il mio brano',
        pageUrl: 'https://audio.com/solco/audio/il-mio-brano',
        license: 'cc-by',
        isListed: true,
      },
      collectionAdded: true,
    });

    const sent = calls();
    expect(sent.map((call) => `${call.method} ${step(call.url)}`)).toEqual([
      `GET ${STORE_HOST}`,
      'POST /v1/audio/create',
      'PUT s3.audio.com',
      'POST /v1/audio/upload/success',
      'POST /v1/collection/item/add',
    ]);
    const [download, create, put, success, add] = sent;
    // Lettura dallo store: nessun token.
    expect(download?.url).toBe(BLOB_URL);
    expect(download?.auth).toBeNull();
    // Create: token di audio.com e i dati del brano.
    expect(create?.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(create?.body))).toEqual({
      name: 'Il mio brano.mp3',
      mime: 'audio/mpeg',
      size: BYTES.byteLength,
      category: 'music',
      title: 'Il mio brano',
      description: 'Registrato a casa.',
      license: 'cc-by',
      is_listed: true,
      is_downloadable: false,
    });
    // PUT all'URL firmato: i byte esatti, il tipo dichiarato, MAI il token.
    expect(put?.url).toBe(POLICY.url);
    expect(put?.auth).toBeNull();
    expect(put?.contentType).toBe('audio/mpeg');
    expect(Array.from(put?.body as Uint8Array)).toEqual(Array.from(BYTES));
    expect(success?.url).toBe(POLICY.success);
    expect(success?.auth).toBe(`Bearer ${TOKEN}`);
    expect(new URL(String(add?.url)).searchParams.get('id')).toBe(COLLECTION_ID);
    expect(JSON.parse(String(add?.body))).toEqual({ audio: [AUDIO_ID] });
    expectTokenOnlyToApi();

    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('audiocom.upload.admin', 'user:admin-1');
    expect(mocks.clearSections).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(BLOB_URL, expect.anything());
  });

  it('senza collection: nessun item/add, collectionAdded null', async () => {
    serve();
    const response = await upload(uploadRequest(validBody({ isListed: false })));
    expect(response.status).toBe(201);
    expect(((await response.json()) as { collectionAdded: unknown }).collectionAdded).toBeNull();
    expect(calls().some((call) => call.url.includes('/v1/collection/'))).toBe(false);
    expect(mocks.listCollections).not.toHaveBeenCalled();
    expect(mocks.clearSections).not.toHaveBeenCalled();
  });

  it('PUT non riuscito: DELETE a `fail` (su api.audio.com), niente success, 503 e staging cancellato', async () => {
    serve({ put: () => new Response('errore', { status: 500 }) });
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { message: string }).message).toContain('audio.com');
    const sent = calls().map((call) => `${call.method} ${step(call.url)}`);
    expect(sent).toContain('DELETE /v1/audio/upload/fail');
    expect(sent).not.toContain('POST /v1/audio/upload/success');
    const fail = calls().find((call) => call.method === 'DELETE');
    expect(fail?.url).toBe(POLICY.fail);
    expect(fail?.auth).toBe(`Bearer ${TOKEN}`);
    expectTokenOnlyToApi();
    expect(mocks.del).toHaveBeenCalledWith(BLOB_URL, expect.anything());
  });

  it('PUT interrotto dalla rete: anche qui `fail` e staging cancellato', async () => {
    serve({
      put: () => {
        throw new TypeError('fetch failed');
      },
    });
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(503);
    expect(calls().some((call) => call.method === 'DELETE' && call.url === POLICY.fail)).toBe(true);
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['success fuori da api.audio.com', { success: 'https://evil.example/success' }],
    ['fail fuori da api.audio.com', { fail: 'https://evil.example/fail' }],
    ['success su http', { success: 'http://api.audio.com/v1/audio/upload/success' }],
    ['success su un host che finge', { success: 'https://api.audio.com.evil.example/success' }],
    ['success con una porta', { success: 'https://api.audio.com:8443/v1/audio/upload/success' }],
    ['PUT verso un indirizzo IP', { url: 'https://10.0.0.5/upload' }],
  ])(
    'policy con %s: il token non parte, niente PUT, il brano creato si cancella',
    async (_label, change) => {
      serve({}, { ...POLICY, ...change });
      const response = await upload(uploadRequest(validBody()));
      expect(response.status).toBe(502);
      const sent = calls();
      expect(sent.some((call) => call.url.includes('evil.example'))).toBe(false);
      expect(sent.some((call) => call.method === 'PUT')).toBe(false);
      expect(sent.some((call) => call.url.includes('/v1/audio/upload/'))).toBe(false);
      const cleanup = sent.find((call) => step(call.url) === '/v1/audio/delete');
      expect(new URL(String(cleanup?.url)).searchParams.get('id')).toBe(AUDIO_ID);
      expect(cleanup?.auth).toBe(`Bearer ${TOKEN}`);
      expectTokenOnlyToApi();
      expect(mocks.del).toHaveBeenCalledWith(BLOB_URL, expect.anything());
    },
  );

  it('success rifiutato da audio.com (formato o dimensione): `fail`, 422', async () => {
    serve({ success: () => json({ status: 422, message: 'Upload mismatch' }, 422) });
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(422);
    expect(calls().some((call) => call.method === 'DELETE' && call.url === POLICY.fail)).toBe(true);
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it('create rifiutato (422 con dettagli): 422 col messaggio, nessun PUT', async () => {
    serve({
      create: () =>
        json({ status: 422, message: 'Invalid', errors: { title: 'Title is too long.' } }, 422),
    });
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { message: string }).message).toContain(
      'Title is too long.',
    );
    expect(calls().some((call) => call.method === 'PUT')).toBe(false);
  });

  it('token rifiutato da audio.com (401): accesso segnato da rinnovare, 503', async () => {
    serve({ create: () => json({ status: 401, message: 'Unauthorized' }, 401) });
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(503);
    expect(mocks.markRejected).toHaveBeenCalledWith(3);
  });

  it('account scollegato: 503 col messaggio, nessuna chiamata ad audio.com', async () => {
    serve();
    mocks.getAccess.mockResolvedValue({ ok: false, reason: 'disconnected' });
    const response = await upload(uploadRequest(validBody()));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { message: string }).message).toBe(
      'Collega prima l’account audio.com.',
    );
    expect(calls().some((call) => new URL(call.url).hostname === 'api.audio.com')).toBe(false);
    expect(mocks.del).toHaveBeenCalledTimes(1);
  });

  it('collection non dell’account: 400 sul campo, nessun brano creato', async () => {
    serve();
    const response = await upload(uploadRequest(validBody({ collectionId: '999' })));
    expect(response.status).toBe(400);
    expect(Object.keys(((await response.json()) as { errors: object }).errors)).toEqual([
      'collectionId',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('il file nello store non corrisponde (dimensione o byte diversi): 400, nessun brano creato', async () => {
    serve();
    mocks.head.mockResolvedValueOnce({ size: 999, contentType: 'audio/mpeg', pathname: '' });
    expect((await upload(uploadRequest(validBody()))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    // head() non risponde: decide la lettura, che conta i byte.
    mocks.head.mockRejectedValueOnce(new Error('timeout'));
    serve({ blob: () => new Response(new Uint8Array(BYTES.byteLength + 3)) });
    expect((await upload(uploadRequest(validBody()))).status).toBe(400);
    expect(calls().some((call) => new URL(call.url).hostname === 'api.audio.com')).toBe(false);

    mocks.head.mockRejectedValueOnce(new mocks.BlobNotFoundError('missing'));
    expect((await upload(uploadRequest(validBody()))).status).toBe(400);
    expect(mocks.del).toHaveBeenCalledTimes(3);
  });

  it('tipo del file diverso da quello dichiarato o non audio: 400 sul formato, nessun brano creato', async () => {
    serve();
    mocks.head.mockResolvedValueOnce({ size: BYTES.byteLength, contentType: 'audio/wav' });
    const declared = await upload(uploadRequest(validBody()));
    expect(declared.status).toBe(400);
    expect(Object.keys(((await declared.json()) as { errors: object }).errors)).toEqual(['mime']);
    expect(fetchMock).not.toHaveBeenCalled();

    // head() non risponde e lo store serve qualcosa che non è audio.
    mocks.head.mockRejectedValueOnce(new Error('timeout'));
    serve({
      blob: () => new Response(BYTES.slice(), { headers: { 'content-type': 'text/html' } }),
    });
    const served = await upload(uploadRequest(validBody()));
    expect(served.status).toBe(400);
    expect(Object.keys(((await served.json()) as { errors: object }).errors)).toEqual(['mime']);
    expect(calls().some((call) => new URL(call.url).hostname === 'api.audio.com')).toBe(false);
  });

  it('oltre il limite orario: la risposta del limite, staging cancellato comunque', async () => {
    mocks.enforceRateLimit.mockResolvedValue(new Response('limite', { status: 429 }));
    expect((await upload(uploadRequest(validBody()))).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.del).toHaveBeenCalledWith(BLOB_URL, expect.anything());
  });
});
