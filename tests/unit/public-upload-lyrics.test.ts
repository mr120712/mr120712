// @polsia:user-owned — testo dei brani caricati (/pubblica): alla creazione un testo richiede la
// conferma dei diritti (400 sul campo, riportato sotto il campo con applyServerErrors); l'autore
// può aggiungere, cambiare o togliere il testo SOLO dei suoi brani (PATCH: sameOrigin, sessione,
// limite, proprietario); il player lo vede solo per brani pubblicati con il testo confermato.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getSessionUser: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  readJsonLimited: vi.fn(),
  premium: vi.fn(),
  head: vi.fn(),
  del: vi.fn(),
  uploadCount: vi.fn(),
  uploadCreate: vi.fn(),
  uploadFindFirst: vi.fn(),
  uploadFindMany: vi.fn(),
  uploadUpdate: vi.fn(),
}));

vi.mock('@/lib/require-auth', () => ({
  requireAuth: mocks.requireAuth,
  getSessionUser: mocks.getSessionUser,
}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/business/request-body.server', () => ({
  readJsonLimited: mocks.readJsonLimited,
  limitedJsonError: () => new Response('too large', { status: 413 }),
}));
vi.mock('@vercel/blob', () => ({ head: mocks.head, del: mocks.del }));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));
vi.mock('@/lib/db', () => {
  const publicUpload = {
    count: mocks.uploadCount,
    create: mocks.uploadCreate,
    findFirst: mocks.uploadFindFirst,
    findMany: mocks.uploadFindMany,
    update: mocks.uploadUpdate,
  };
  return {
    prisma: {
      publicUpload,
      // La registrazione usa una transazione interattiva (lock per utente + conteggio + creazione).
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ $queryRaw: async () => [{ locked: 1 }], publicUpload }),
    },
  };
});

import { PATCH } from '@/app/api/music/public-uploads/[uploadId]/route';
import { POST } from '@/app/api/music/public-uploads/route';
import { checkLyricsFields, lyricsErrorsFromServer } from '@/components/custom/music/upload-lyrics';
import { UPLOAD_LYRICS_MAX_CHARS } from '@/lib/contracts/lyrics';
import {
  LYRICS_FIELD_MESSAGES,
  PublicUploadCreateSchema,
  PublicUploadLyricsUpdateSchema,
} from '@/lib/contracts/public-uploads';
import {
  listMyPublicUploads,
  listPublicUploads,
  readPublishedUploadLyrics,
  registerPublicUpload,
  updatePublicUploadLyrics,
} from '@/lib/music/public-uploads.server';

const ID = 'c'.repeat(25);
const BLOB_URL = 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3';
const VALID = {
  title: 'Brano',
  blobUrl: BLOB_URL,
  blobPathname: 'public-uploads/x.mp3',
  mimeType: 'audio/mpeg',
  byteLength: 1000,
  elapsedSeconds: 100,
};
const LRC = '[00:01.00]Prima riga\n[00:03.00]Seconda riga';
const ROW = {
  id: ID,
  uploaderUserId: 'user-1',
  title: 'Brano',
  artist: null,
  blobUrl: BLOB_URL,
  durationSeconds: 100,
  published: true,
  playCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const params = { params: Promise.resolve({ uploadId: ID }) };
function patchRequest() {
  return new Request(`https://solco.example/api/music/public-uploads/${ID}`, { method: 'PATCH' });
}
function postRequest() {
  return new Request('https://solco.example/api/music/public-uploads', { method: 'POST' });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.uploadCount.mockResolvedValue(0);
  mocks.head.mockResolvedValue({ contentType: 'audio/mpeg' });
});

describe('contratto', () => {
  it('creazione: testo senza conferma → errore sul campo lyricsRightsConfirmed', () => {
    const result = PublicUploadCreateSchema.safeParse({ ...VALID, lyrics: LRC });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['lyricsRightsConfirmed', LYRICS_FIELD_MESSAGES.confirm],
    ]);
  });

  it('creazione: testo confermato normalizzato; nessun testo resta valido (compatibile)', () => {
    const result = PublicUploadCreateSchema.safeParse({
      ...VALID,
      lyrics: '\r\nUno\r\n\r\n\r\nDue  \r\n',
      lyricsRightsConfirmed: true,
    });
    expect(result.success && result.data.lyrics).toBe('Uno\n\nDue');
    expect(PublicUploadCreateSchema.safeParse(VALID).success).toBe(true);
    // Solo spazi = nessun testo: non serve la conferma.
    expect(PublicUploadCreateSchema.safeParse({ ...VALID, lyrics: '  \n ' }).success).toBe(true);
  });

  it('testo troppo lungo o senza righe leggibili → errore sul campo lyrics', () => {
    const tooLong = PublicUploadLyricsUpdateSchema.safeParse({
      lyrics: 'a'.repeat(UPLOAD_LYRICS_MAX_CHARS + 1),
      lyricsRightsConfirmed: true,
    });
    expect(tooLong.error?.issues[0]).toMatchObject({
      path: ['lyrics'],
      message: LYRICS_FIELD_MESSAGES.tooLong,
    });
    const onlyTags = PublicUploadLyricsUpdateSchema.safeParse({
      lyrics: '[ar:Io]\n[ti:Titolo]',
      lyricsRightsConfirmed: true,
    });
    expect(onlyTags.error?.issues[0]).toMatchObject({
      path: ['lyrics'],
      message: LYRICS_FIELD_MESSAGES.unreadable,
    });
    expect(PublicUploadLyricsUpdateSchema.safeParse({ lyrics: null, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('POST /api/music/public-uploads con il testo', () => {
  it('testo senza conferma: 400 { errors: { lyricsRightsConfirmed } }, niente registrazione', async () => {
    mocks.readJsonLimited.mockResolvedValue({ ok: true, value: { ...VALID, lyrics: LRC } });
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ errors: { lyricsRightsConfirmed: LYRICS_FIELD_MESSAGES.confirm } });
    expect(mocks.uploadCreate).not.toHaveBeenCalled();
    // Il 400 torna sotto il campo giusto del form (applyServerErrors).
    expect(lyricsErrorsFromServer(body)).toEqual({
      fields: { lyricsRightsConfirmed: LYRICS_FIELD_MESSAGES.confirm },
      other: null,
    });
    // Corpo più grande dei soli metadati: c'è spazio per il testo.
    expect(mocks.readJsonLimited.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(100 * 1024);
  });

  it('testo confermato: salvato con la conferma; 201', async () => {
    mocks.readJsonLimited.mockResolvedValue({
      ok: true,
      value: { ...VALID, lyrics: LRC, lyricsRightsConfirmed: true },
    });
    mocks.uploadCreate.mockImplementation(async ({ data }) => ({ ...ROW, ...data }));
    const res = await POST(postRequest());
    expect(res.status).toBe(201);
    expect(mocks.uploadCreate.mock.calls[0]?.[0].data).toMatchObject({
      lyrics: LRC,
      lyricsRightsConfirmed: true,
    });
    const body = await res.json();
    expect(body.upload).toMatchObject({ lyrics: LRC, lyricsRightsConfirmed: true, mine: true });
  });
});

describe('PATCH /api/music/public-uploads/[id] (testo del proprio brano)', () => {
  it('403 da un’altra origine, prima di tutto il resto', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await PATCH(patchRequest(), params);
    expect(res.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it('401 senza sessione', async () => {
    mocks.requireAuth.mockRejectedValue(new Response(null, { status: 401 }));
    expect((await PATCH(patchRequest(), params)).status).toBe(401);
  });

  it('404 su id malformato; limite applicato per utente', async () => {
    const bad = await PATCH(patchRequest(), { params: Promise.resolve({ uploadId: '../x' }) });
    expect(bad.status).toBe(404);
    mocks.enforceRateLimit.mockResolvedValue(new Response(null, { status: 429 }));
    const limited = await PATCH(patchRequest(), params);
    expect(limited.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('library.write', 'user:user-1');
    expect(mocks.readJsonLimited).not.toHaveBeenCalled();
  });

  it('400 con l’errore sul campo se manca la conferma', async () => {
    mocks.readJsonLimited.mockResolvedValue({ ok: true, value: { lyrics: LRC } });
    const res = await PATCH(patchRequest(), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      errors: { lyricsRightsConfirmed: LYRICS_FIELD_MESSAGES.confirm },
    });
    expect(mocks.uploadUpdate).not.toHaveBeenCalled();
  });

  it('brano di un altro utente: 404, nessuna modifica', async () => {
    mocks.readJsonLimited.mockResolvedValue({
      ok: true,
      value: { lyrics: LRC, lyricsRightsConfirmed: true },
    });
    mocks.uploadFindFirst.mockResolvedValue(null);
    const res = await PATCH(patchRequest(), params);
    expect(res.status).toBe(404);
    expect(mocks.uploadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, uploaderUserId: 'user-1' } }),
    );
    expect(mocks.uploadUpdate).not.toHaveBeenCalled();
  });

  it('proprietario: salva il testo; null lo toglie (e toglie la conferma)', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ id: ID });
    mocks.uploadUpdate.mockImplementation(async ({ data }) => ({ ...ROW, ...data }));
    mocks.readJsonLimited.mockResolvedValue({
      ok: true,
      value: { lyrics: LRC, lyricsRightsConfirmed: true },
    });
    const saved = await PATCH(patchRequest(), params);
    expect(saved.status).toBe(200);
    expect((await saved.json()).upload).toMatchObject({ lyrics: LRC, lyricsRightsConfirmed: true });
    expect(mocks.uploadUpdate.mock.calls[0]?.[0]).toMatchObject({
      where: { id: ID },
      data: { lyrics: LRC, lyricsRightsConfirmed: true },
    });

    mocks.readJsonLimited.mockResolvedValue({ ok: true, value: { lyrics: null } });
    const removed = await PATCH(patchRequest(), params);
    expect(removed.status).toBe(200);
    expect(mocks.uploadUpdate.mock.calls[1]?.[0].data).toEqual({
      lyrics: null,
      lyricsRightsConfirmed: false,
    });
  });
});

describe('server: chi vede il testo', () => {
  it('readPublishedUploadLyrics: solo pubblicato e confermato, credito dell’autore', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ lyrics: LRC });
    expect(await readPublishedUploadLyrics(ID)).toEqual({
      kind: 'synced',
      lines: [
        { timeMs: 1000, text: 'Prima riga' },
        { timeMs: 3000, text: 'Seconda riga' },
      ],
      source: 'upload',
      credit: "Testo pubblicato dall'autore",
    });
    expect(mocks.uploadFindFirst).toHaveBeenCalledWith({
      where: { id: ID, published: true, lyricsRightsConfirmed: true },
      select: { lyrics: true },
    });
    mocks.uploadFindFirst.mockResolvedValue(null);
    expect(await readPublishedUploadLyrics(ID)).toBeNull();
    mocks.uploadFindFirst.mockResolvedValue({ lyrics: null });
    expect(await readPublishedUploadLyrics(ID)).toBeNull();
  });

  it('la classifica pubblica non porta il testo; i "tuoi brani" sì', async () => {
    mocks.uploadFindMany.mockResolvedValue([{ ...ROW, lyrics: LRC, lyricsRightsConfirmed: true }]);
    const [publicRow] = await listPublicUploads('altro', true);
    expect(publicRow).not.toHaveProperty('lyrics');
    expect(mocks.uploadFindMany.mock.calls[0]?.[0].select).not.toHaveProperty('lyrics');
    const [mine] = await listMyPublicUploads('user-1');
    expect(mine).toMatchObject({ lyrics: LRC, lyricsRightsConfirmed: true });
    expect(mocks.uploadFindMany.mock.calls[1]?.[0].select).toMatchObject({ lyrics: true });
  });

  it('registerPublicUpload senza conferma non salva il testo (difesa in profondità)', async () => {
    mocks.uploadCreate.mockImplementation(async ({ data }) => ({ ...ROW, ...data }));
    await registerPublicUpload('user-1', { ...VALID, lyrics: LRC });
    expect(mocks.uploadCreate.mock.calls[0]?.[0].data).toMatchObject({
      lyrics: null,
      lyricsRightsConfirmed: false,
    });
  });

  it('updatePublicUploadLyrics: null se il brano non è dell’utente', async () => {
    mocks.uploadFindFirst.mockResolvedValue(null);
    expect(
      await updatePublicUploadLyrics('intruso', ID, { lyrics: LRC, lyricsRightsConfirmed: true }),
    ).toBeNull();
    expect(mocks.uploadUpdate).not.toHaveBeenCalled();
  });
});

describe('form: controllo prima dell’invio', () => {
  it('checkLyricsFields usa lo stesso contratto del server', () => {
    expect(checkLyricsFields({ lyrics: '', lyricsRightsConfirmed: false })).toEqual({});
    expect(checkLyricsFields({ lyrics: LRC, lyricsRightsConfirmed: true })).toEqual({});
    expect(checkLyricsFields({ lyrics: LRC, lyricsRightsConfirmed: false })).toEqual({
      lyricsRightsConfirmed: LYRICS_FIELD_MESSAGES.confirm,
    });
  });

  it('lyricsErrorsFromServer separa i campi del testo dagli altri', () => {
    expect(
      lyricsErrorsFromServer({ errors: { lyrics: 'Troppo lungo', title: 'Titolo mancante' } }),
    ).toEqual({ fields: { lyrics: 'Troppo lungo' }, other: 'Titolo mancante' });
    expect(lyricsErrorsFromServer({ error: 'limit_reached' })).toEqual({ fields: {}, other: null });
  });
});
