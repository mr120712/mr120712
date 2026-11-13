// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  head: vi.fn(),
  del: vi.fn(),
  uploadCount: vi.fn(),
  uploadCreate: vi.fn(),
  uploadFindMany: vi.fn(),
  uploadFindFirst: vi.fn(),
  uploadFindUnique: vi.fn(),
  uploadUpdate: vi.fn(),
  uploadDelete: vi.fn(),
  reportCreate: vi.fn(),
  reportCount: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({ head: mocks.head, del: mocks.del }));
vi.mock('@/lib/env', () => ({ env: { BLOB_READ_WRITE_TOKEN: 'tok_test' } }));
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
  },
}));

import {
  AUTO_UNPUBLISH_REPORTS,
  deletePublicUpload,
  InvalidPublicUploadSource,
  MAX_UPLOADS_PER_USER,
  PublicUploadLimitReached,
  recordPublicUploadPlay,
  registerPublicUpload,
  reportPublicUpload,
} from '@/lib/music/public-uploads.server';

const validInput = {
  title: 'Brano',
  artist: 'Io',
  blobUrl: 'https://abc.public.blob.vercel-storage.com/public-uploads/x.mp3',
  blobPathname: 'public-uploads/x.mp3',
  mimeType: 'audio/mpeg',
  byteLength: 1000,
  elapsedSeconds: 120,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('registerPublicUpload', () => {
  it('registra un brano valido dopo aver verificato l’oggetto su Blob', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.head.mockResolvedValue({
      contentType: 'audio/mpeg',
      size: 1000,
      pathname: 'public-uploads/x.mp3',
    });
    mocks.uploadCreate.mockResolvedValue({
      id: 'c'.repeat(25),
      uploaderUserId: 'user-1',
      title: 'Brano',
      artist: 'Io',
      blobUrl: validInput.blobUrl,
      durationSeconds: 120,
      playCount: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const result = await registerPublicUpload('user-1', validInput);
    expect(result.title).toBe('Brano');
    expect(result.streamUrl).toBe(validInput.blobUrl);
    expect(result.mine).toBe(true);
  });

  it('rifiuta un percorso fuori dal prefisso consentito', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    await expect(
      registerPublicUpload('user-1', { ...validInput, blobPathname: 'altrove/x.mp3' }),
    ).rejects.toBeInstanceOf(InvalidPublicUploadSource);
    expect(mocks.head).not.toHaveBeenCalled();
  });

  it('tollera dimensione/percorso diversi da head (formati di Blob), basta che sia audio', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.head.mockResolvedValue({
      contentType: 'audio/mpeg',
      size: 999, // diversa da byteLength: non deve far fallire
      pathname: '/public-uploads/x.mp3', // slash iniziale: non deve far fallire
    });
    mocks.uploadCreate.mockResolvedValue({
      id: 'c'.repeat(25),
      uploaderUserId: 'user-1',
      title: 'Brano',
      artist: 'Io',
      blobUrl: validInput.blobUrl,
      durationSeconds: 120,
      playCount: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const result = await registerPublicUpload('user-1', validInput);
    expect(result.title).toBe('Brano');
  });

  it('rifiuta un contenuto non audio', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.head.mockResolvedValue({
      contentType: 'application/octet-stream',
      size: 1000,
      pathname: 'public-uploads/x.mp3',
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

  it('registra comunque se head() va in timeout/errore (degradazione, niente blocco)', async () => {
    mocks.uploadCount.mockResolvedValue(0);
    mocks.head.mockRejectedValue(new Error('timeout'));
    mocks.uploadCreate.mockResolvedValue({
      id: 'c'.repeat(25),
      uploaderUserId: 'user-1',
      title: 'Brano',
      artist: 'Io',
      blobUrl: validInput.blobUrl,
      durationSeconds: 120,
      playCount: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const result = await registerPublicUpload('user-1', validInput);
    expect(result.title).toBe('Brano');
    expect(mocks.uploadCreate).toHaveBeenCalled();
  });
});

describe('reportPublicUpload', () => {
  it('404 (false) se il brano pubblicato non esiste', async () => {
    mocks.uploadFindFirst.mockResolvedValue(null);
    expect(await reportPublicUpload('c'.repeat(25), 'user-2')).toBe(false);
  });

  it('auto-ritira oltre la soglia E cancella l’oggetto Blob (takedown vero)', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ id: 'c'.repeat(25) });
    mocks.reportCreate.mockResolvedValue({});
    mocks.reportCount.mockResolvedValue(AUTO_UNPUBLISH_REPORTS);
    mocks.uploadUpdate.mockResolvedValue({ blobUrl: validInput.blobUrl });
    mocks.del.mockResolvedValue(undefined);
    const ok = await reportPublicUpload('c'.repeat(25), 'user-2');
    expect(ok).toBe(true);
    expect(mocks.uploadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { published: false } }),
    );
    expect(mocks.del).toHaveBeenCalledWith(validInput.blobUrl, expect.anything());
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
  it('cancella l’oggetto Blob e la riga per il proprietario', async () => {
    mocks.uploadFindFirst.mockResolvedValue({ id: 'c'.repeat(25), blobUrl: validInput.blobUrl });
    mocks.del.mockResolvedValue(undefined);
    mocks.uploadDelete.mockResolvedValue({});
    expect(await deletePublicUpload('user-1', 'c'.repeat(25))).toBe(true);
    expect(mocks.del).toHaveBeenCalled();
    expect(mocks.uploadDelete).toHaveBeenCalled();
  });

  it('false se il brano non è dell’utente', async () => {
    mocks.uploadFindFirst.mockResolvedValue(null);
    expect(await deletePublicUpload('user-1', 'c'.repeat(25))).toBe(false);
    expect(mocks.del).not.toHaveBeenCalled();
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
