// @polsia:user-owned
// @vitest-environment node
//
// File dei brani pubblicati di un account cancellato: tolti dalla CDN in una sola chiamata, senza
// mai far fallire una cancellazione dell'account già avvenuta.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  del: vi.fn(),
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test' as string | undefined },
}));

vi.mock('server-only', () => ({}));
vi.mock('@vercel/blob', () => ({ del: mocks.del, head: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { deletePublicUploadBlobs } from '@/lib/music/public-uploads.server';

const URLS = [
  'https://blob.example/public-uploads/uno.mp3',
  'https://blob.example/public-uploads/due.mp3',
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.BLOB_READ_WRITE_TOKEN = 'tok_test';
  mocks.del.mockResolvedValue(undefined);
});

describe('deletePublicUploadBlobs', () => {
  it('toglie tutti i file in una sola chiamata, col token di Blob', async () => {
    await deletePublicUploadBlobs(URLS);

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(URLS, { token: 'tok_test' });
  });

  it('nessun file: nessuna chiamata a Blob', async () => {
    await deletePublicUploadBlobs([]);

    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('Blob non configurato: nessuna chiamata', async () => {
    mocks.env.BLOB_READ_WRITE_TOKEN = undefined;

    await deletePublicUploadBlobs(URLS);

    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('Blob non raggiungibile: non lancia (l’account è già cancellato)', async () => {
    mocks.del.mockRejectedValueOnce(new Error('rete giù'));

    await expect(deletePublicUploadBlobs(URLS)).resolves.toBeUndefined();
  });
});
