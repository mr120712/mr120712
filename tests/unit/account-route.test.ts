// @polsia:user-owned
// @vitest-environment node
//
// DELETE /api/account: la cancellazione vera (deleteAccountData) dentro una transazione finta.
// I file dei brani pubblicati spariscono dalla CDN solo DOPO il commit, mai se la transazione fallisce.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  transaction: vi.fn(),
  deleteBlobs: vi.fn(),
  events: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('@/lib/music/public-uploads.server', () => ({
  deletePublicUploadBlobs: mocks.deleteBlobs,
}));

import { DELETE } from '@/app/api/account/route';
import { ACCOUNT_DELETION_CONFIRMATION } from '@/lib/contracts/account-deletion';

const BLOB_URLS = ['https://blob.example/public-uploads/uno.mp3'];

function deletionRequest(confirmation = ACCOUNT_DELETION_CONFIRMATION) {
  return new Request('https://solco.test/api/account', {
    method: 'DELETE',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation }),
  });
}

/** Client di transazione finto: ogni modello cancella, i brani pubblicati hanno un file. */
function fakeTransaction() {
  return new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === 'user') {
          return {
            delete: async () => {
              mocks.events.push('user.delete');
              return {};
            },
          };
        }
        return {
          findMany: async () =>
            model === 'publicUpload' ? BLOB_URLS.map((blobUrl) => ({ blobUrl })) : [],
          deleteMany: async () => ({ count: 1 }),
        };
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue({ id: 'user-1', email: 'utente@example.test' });
  mocks.deleteBlobs.mockImplementation(async () => {
    mocks.events.push('blob.delete');
  });
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    const result = await run(fakeTransaction());
    mocks.events.push('commit');
    return result;
  });
});

describe('DELETE /api/account', () => {
  it('cancella l’account, poi toglie dalla CDN i file dei brani pubblicati', async () => {
    const response = await DELETE(deletionRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(mocks.deleteBlobs).toHaveBeenCalledWith(BLOB_URLS);
    expect(mocks.events).toEqual(['user.delete', 'commit', 'blob.delete']);
  });

  it('transazione fallita: errore 500 e nessun file tolto dalla CDN', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('connessione persa'));

    const response = await DELETE(deletionRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'account_deletion_failed' });
    expect(mocks.deleteBlobs).not.toHaveBeenCalled();
  });

  it('senza la frase di conferma non tocca né il database né la CDN', async () => {
    const response = await DELETE(deletionRequest('ELIMINA'));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.deleteBlobs).not.toHaveBeenCalled();
  });

  it('origine diversa: 403 prima dell’autenticazione', async () => {
    mocks.sameOrigin.mockReturnValue(false);

    const response = await DELETE(deletionRequest());

    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
