// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  headObject: vi.fn(),
  deleteObject: vi.fn(),
  uploadCount: vi.fn(),
  uploadCreate: vi.fn(),
  uploadFindMany: vi.fn(),
  uploadFindFirst: vi.fn(),
  uploadFindUnique: vi.fn(),
  uploadUpdate: vi.fn(),
  uploadDelete: vi.fn(),
  reportCreate: vi.fn(),
  reportCount: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@/lib/music/s3-storage.server', () => ({
  isS3Configured: () => true,
  headObject: mocks.headObject,
  deleteObject: mocks.deleteObject,
  s3ObjectUrl: (key: string) => `https://bucket.s3.eu-west-1.amazonaws.com/${key}`,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    publicUpload: {
      count: mocks.uploadCount,
      create: mocks.uploadCreate,
      findMany: mocks.uploadFindMany,
      findFirst: mocks.uploadFindFirst,
      findUnique: mocks.uploadFindUnique,
      update: mocks.uploadUpdate,
      delete: mocks.uploadDelete,
    },
    publicUploadReport: { create: mocks.reportCreate, count: mocks.reportCount },
    $transaction: mocks.transaction,
  },
}));

import {
  AUTO_UNPUBLISH_REPORTS,
  deletePublicUpload,
  InvalidPublicUploadSource,
  listPublicUploads,
  MAX_UPLOADS_PER_USER,
  PublicUploadLimitReached,
  recordPublicUploadPlay,
  registerPublicUpload,
  reportPublicUpload,
} from '@/lib/music/public-uploads.server';

const KEY = 'public-uploads/x.mp3';
const OBJECT_URL = `https://bucket.s3.eu-west-1.amazonaws.com/${KEY}`;

const validInput = {
  title: 'Brano',
  artist: 'Io',
  key: KEY,
  mimeType: 'audio/mpeg',
  byteLength: 1000,
  elapsedSeconds: 120,
};

const createdRow = {
  id: 'c'.repeat(25),
  uploaderUserId: 'user-1',
  title: 'Brano',
  artist: 'Io',
  blobUrl: OBJECT_URL,
  durationSeconds: 120,
  published: true,
  playCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

beforeEach(() => {
  vi.resetAllMocks();
  // La transazione interattiva esegue la callback con un client che espone gli stessi mock.
  mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ publicUpload: { count: mocks.uploadCount, create: mocks.uploadCreate } }),
  );
});

describe('registerPublicUpload', () => {
  it('registra un brano valido e deriva l’URL dalla chiave', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.headObject.mockResolvedValue({ contentType: 'audio/mpeg', contentLength: 1000 });
    mocks.uploadCreate.mockResolvedValue(createdRow);
    const result = await registerPublicUpload('user-1', validInput);
    expect(result.title).toBe('Brano');
    expect(result.streamUrl).toBe(OBJECT_URL);
    expect(result.mine).toBe(true);
    // Il proprietario può sempre ascoltare il proprio brano.
    expect(result.canPlay).toBe(true);
    // L'URL e la chiave salvati sono derivati dal server, non dal client.
    expect(mocks.uploadCreate.mock.calls[0]?.[0].data).toMatchObject({
      blobUrl: OBJECT_URL,
      blobPathname: KEY,
    });
  });

  it('rifiuta una chiave fuori dal prefisso consentito (senza chiamare S3)', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    await expect(
      registerPublicUpload('user-1', { ...validInput, key: 'altrove/x.mp3' }),
    ).rejects.toBeInstanceOf(InvalidPublicUploadSource);
    expect(mocks.headObject).not.toHaveBeenCalled();
  });

  it('rifiuta un contenuto non audio', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.headObject.mockResolvedValue({
      contentType: 'application/octet-stream',
      contentLength: 1000,
    });
    await expect(registerPublicUpload('user-1', validInput)).rejects.toBeInstanceOf(
      InvalidPublicUploadSource,
    );
  });

  it('blocca oltre il tetto per utente', async () => {
    mocks.uploadCount.mockResolvedValue(MAX_UPLOADS_PER_USER);
    await expect(registerPublicUpload('user-1', validInput)).rejects.toBeInstanceOf(
      PublicUploadLimitReached,
    );
  });

  it('registra comunque se HEAD va in timeout/errore (fail-open, niente blocco)', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.headObject.mockResolvedValue(null);
    mocks.uploadCreate.mockResolvedValue(createdRow);
    const result = await registerPublicUpload('user-1', validInput);
    expect(result.title).toBe('Brano');
    expect(mocks.uploadCreate).toHaveBeenCalled();
  });

  it('rifiuta e rimuove da S3 un oggetto oltre il tetto di dimensione (PUT firmato non vincola)', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.headObject.mockResolvedValue({
      contentType: 'audio/mpeg',
      contentLength: 41 * 1024 * 1024,
    });
    await expect(registerPublicUpload('user-1', validInput)).rejects.toBeInstanceOf(
      InvalidPublicUploadSource,
    );
    expect(mocks.deleteObject).toHaveBeenCalledWith(KEY);
    expect(mocks.uploadCreate).not.toHaveBeenCalled();
  });
});

describe('listPublicUploads (ascolto solo Premium)', () => {
  // Brano pubblicato da un altro utente.
  const publicRow = { ...createdRow, uploaderUserId: 'owner' };

  it('un non-Premium non proprietario NON riceve lo streamUrl (anteprima bloccata)', async () => {
    mocks.uploadFindMany.mockResolvedValue([publicRow]);
    const [row] = await listPublicUploads('viewer', false);
    expect(row?.canPlay).toBe(false);
    expect(row?.streamUrl).toBeNull();
    expect(row?.mine).toBe(false);
  });

  it('un utente Premium riceve lo streamUrl e può ascoltare', async () => {
    mocks.uploadFindMany.mockResolvedValue([publicRow]);
    const [row] = await listPublicUploads('viewer', true);
    expect(row?.canPlay).toBe(true);
    expect(row?.streamUrl).toBe(OBJECT_URL);
  });

  it('il proprietario può ascoltare i propri brani anche senza Premium', async () => {
    mocks.uploadFindMany.mockResolvedValue([publicRow]);
    const [row] = await listPublicUploads('owner', false);
    expect(row?.mine).toBe(true);
    expect(row?.canPlay).toBe(true);
    expect(row?.streamUrl).toBe(OBJECT_URL);
  });

  it('un ospite (non loggato) non può ascoltare', async () => {
    mocks.uploadFindMany.mockResolvedValue([publicRow]);
    const [row] = await listPublicUploads(null, false);
    expect(row?.canPlay).toBe(false);
    expect(row?.streamUrl).toBeNull();
  });
});

describe('reportPublicUpload', () => {
  it('404 (false) se il brano pubblicato non esiste', async () => {
    mocks.uploadFindFirst.mockResolvedValue(null);
    expect(await reportPublicUpload('c'.repeat(25), 'user-2')).toBe(false);
  });

  it('auto-ritira oltre la soglia E cancella l’oggetto su S3 (takedown vero, per chiave)', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ id: 'c'.repeat(25) });
    mocks.reportCreate.mockResolvedValue({});
    mocks.reportCount.mockResolvedValue(AUTO_UNPUBLISH_REPORTS);
    mocks.uploadUpdate.mockResolvedValue({ blobPathname: KEY });
    const ok = await reportPublicUpload('c'.repeat(25), 'user-2');
    expect(ok).toBe(true);
    expect(mocks.uploadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { published: false } }),
    );
    expect(mocks.deleteObject).toHaveBeenCalledWith(KEY);
  });

  it('non ritira sotto la soglia', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ id: 'c'.repeat(25) });
    mocks.reportCreate.mockResolvedValue({});
    mocks.reportCount.mockResolvedValue(AUTO_UNPUBLISH_REPORTS - 1);
    await reportPublicUpload('c'.repeat(25), 'user-2');
    expect(mocks.uploadUpdate).not.toHaveBeenCalled();
  });
});

describe('deletePublicUpload', () => {
  it('cancella l’oggetto su S3 (per chiave) e la riga per il proprietario', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ id: 'c'.repeat(25), blobPathname: KEY });
    mocks.uploadDelete.mockResolvedValue({});
    expect(await deletePublicUpload('user-1', 'c'.repeat(25))).toBe(true);
    expect(mocks.deleteObject).toHaveBeenCalledWith(KEY);
    expect(mocks.uploadDelete).toHaveBeenCalled();
  });

  it('false se il brano non è dell’utente', async () => {
    mocks.uploadFindFirst.mockResolvedValue(null);
    expect(await deletePublicUpload('user-1', 'c'.repeat(25))).toBe(false);
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });
});

describe('recordPublicUploadPlay', () => {
  it('conta l’ascolto di un ascoltatore diverso dal proprietario', async () => {
    mocks.uploadFindUnique.mockResolvedValue({ uploaderUserId: 'owner' });
    await recordPublicUploadPlay('c'.repeat(25), 'listener');
    expect(mocks.uploadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { playCount: { increment: 1 } } }),
    );
  });

  it('NON conta l’ascolto del proprietario (niente auto-gonfiaggio)', async () => {
    mocks.uploadFindUnique.mockResolvedValue({ uploaderUserId: 'owner' });
    await recordPublicUploadPlay('c'.repeat(25), 'owner');
    expect(mocks.uploadUpdate).not.toHaveBeenCalled();
  });

  it('conta gli ascolti anonimi', async () => {
    mocks.uploadFindUnique.mockResolvedValue({ uploaderUserId: 'owner' });
    await recordPublicUploadPlay('c'.repeat(25), null);
    expect(mocks.uploadUpdate).toHaveBeenCalled();
  });
});
