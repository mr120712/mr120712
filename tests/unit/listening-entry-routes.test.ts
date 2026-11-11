// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/require-auth';
import type { CreateListeningEntry } from '@/lib/contracts/music';

type EntryRow = {
  id: string;
  userId: string;
  albumId: string;
  catalogProvider: string;
  albumName: string;
  artistName: string;
  artworkUrl: string | null;
  releaseDate: string | null;
  genre: string | null;
  trackCount: number | null;
  storeUrl: string | null;
  rating: number;
  note: string;
  listenedOn: Date;
  context: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/db', () => ({
  prisma: {
    listeningEntry: {
      findMany: mocks.findMany,
      count: mocks.count,
      create: mocks.create,
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from '@/app/api/listening-entries/route';
import { GET as GETUsage } from '@/app/api/listening-entries/usage/route';
import { PATCH } from '@/app/api/listening-entries/[entryId]/route';

const accountA = { id: 'account-a' } as unknown as SessionUser;
const accountB = { id: 'account-b' } as unknown as SessionUser;
type CreateData = Omit<EntryRow, 'id' | 'updatedAt'>;
type MockTransactionClient = {
  listeningEntry: { count: typeof mocks.count; create: typeof mocks.create };
};
type MockTransactionOperation = (transaction: MockTransactionClient) => Promise<unknown>;
const transactionClient: MockTransactionClient = {
  listeningEntry: { count: mocks.count, create: mocks.create },
};
const rows: EntryRow[] = [
  {
    id: 'entry-a', userId: 'account-a', albumId: '101', catalogProvider: 'legacy', albumName: 'Album A', artistName: 'Artista A',
    artworkUrl: null, releaseDate: '2007-10-10T07:00:00Z',
    genre: 'Alternative', trackCount: 10, storeUrl: null,
    rating: 4.5, note: 'Nota A', listenedOn: new Date('2026-11-01T12:00:00Z'),
    context: null, createdAt: new Date('2026-11-01T12:00:00Z'), updatedAt: new Date('2026-11-01T12:00:00Z'),
  },
  {
    id: 'entry-b', userId: 'account-b', albumId: '202', catalogProvider: 'legacy', albumName: 'Album B', artistName: 'Artista B',
    artworkUrl: null, releaseDate: null, genre: null, trackCount: null, storeUrl: null,
    rating: 3, note: 'Nota B', listenedOn: new Date('2026-11-02T12:00:00Z'),
    context: 'treno', createdAt: new Date('2026-11-02T12:00:00Z'), updatedAt: new Date('2026-11-02T12:00:00Z'),
  },
];

function request(path: string, init?: RequestInit) {
  return new Request(`https://solco.test${path}`, init);
}

function createRequest(overrides: Partial<CreateListeningEntry> = {}) {
  return request('/api/listening-entries', {
    method: 'POST',
    headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
    body: JSON.stringify({
      albumId: '101',
      catalogProvider: 'legacy',
      albumName: 'Album A',
      artistName: 'Artista A',
      artworkUrl: null,
      releaseDate: '2007-10-10T07:00:00Z',
      genre: 'Alternative',
      trackCount: 10,
      rating: 4,
      note: 'Una nota',
      listenedOn: '1999-01-01',
      videoUrl: 'https://example.invalid/album.mp4',
      ...overrides,
    }),
  });
}

describe('API del diario personale', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sameOrigin.mockReturnValue(true);
    mocks.requireAuth.mockResolvedValue(accountA);
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    mocks.create.mockImplementation(async (args: { data: CreateData }) => ({
      id: 'entry-new',
      ...args.data,
      updatedAt: args.data.createdAt,
    }));
    mocks.transaction.mockImplementation(async (operation: MockTransactionOperation) =>
      operation(transactionClient),
    );
  });

  it('rifiuta l’accesso anonimo prima di leggere il diario', async () => {
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await GET(request('/api/listening-entries'));

    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('restituisce ad ogni account soltanto i propri ascolti', async () => {
    mocks.findMany.mockImplementation(async (args: { where: { userId: string } }) =>
      rows.filter((entry) => entry.userId === args.where.userId),
    );

    const resultA = await GET(request('/api/listening-entries'));
    expect((await resultA.json()).entries.map((entry: { id: string }) => entry.id)).toEqual(['entry-a']);

    mocks.requireAuth.mockResolvedValue(accountB);
    const resultB = await GET(request('/api/listening-entries'));
    expect((await resultB.json()).entries.map((entry: { id: string }) => entry.id)).toEqual(['entry-b']);
    expect(mocks.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { userId: 'account-a' } }));
    expect(mocks.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { userId: 'account-b' } }));
  });

  it('rifiuta una scrittura cross-origin prima di autenticazione e database', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await POST(request('/api/listening-entries', {
      method: 'POST',
      headers: { origin: 'https://altra-origine.test', 'content-type': 'application/json' },
      body: JSON.stringify({ albumId: '101' }),
    }));

    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('consente la quarantesima registrazione quando il conteggio mensile è 39', async () => {
    mocks.count.mockResolvedValue(39);
    const response = await POST(createRequest());

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.usage).toMatchObject({ used: 40, limit: 40, remaining: 0 });
    expect(body.entry).toMatchObject({
      albumId: '101',
      catalogProvider: 'legacy',
      albumName: 'Album A',
      releaseDate: '2007-10-10T07:00:00Z',
      genre: 'Alternative',
      trackCount: 10,
      artworkUrl: null,
    });
    expect(body.entry).not.toHaveProperty('previewUrl');
    expect(body.entry).not.toHaveProperty('videoUrl');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        catalogProvider: 'legacy',
        releaseDate: '2007-10-10T07:00:00Z',
        genre: 'Alternative',
        trackCount: 10,
        artworkUrl: null,
      }),
    }));
    expect(mocks.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'account-a',
        createdAt: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }),
      }),
    }));
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('mantiene assenti i metadati che il catalogo non ha restituito', async () => {
    const response = await POST(createRequest({
      artworkUrl: null,
      releaseDate: null,
      genre: null,
      trackCount: null,
    }));

    expect(response.status).toBe(201);
    expect((await response.json()).entry).toMatchObject({
      artworkUrl: null,
      releaseDate: null,
      genre: null,
      trackCount: null,
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        artworkUrl: null,
        releaseDate: null,
        genre: null,
        trackCount: null,
      }),
    }));
  });

  it('rifiuta la quarantunesima registrazione con 409 senza salvarla', async () => {
    mocks.count.mockResolvedValue(40);
    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('limite di 40 ascolti');
    expect(body.usage).toMatchObject({ used: 40, limit: 40, remaining: 0 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('mantiene quote separate per account anche quando uno ha già raggiunto il limite', async () => {
    mocks.count.mockImplementation(async (args: { where: { userId: string } }) =>
      args.where.userId === 'account-a' ? 40 : 0,
    );

    const exhausted = await POST(createRequest());
    mocks.requireAuth.mockResolvedValue(accountB);
    const available = await POST(createRequest());

    expect(exhausted.status).toBe(409);
    expect(available.status).toBe(201);
    expect(mocks.count).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ userId: 'account-a' }) }));
    expect(mocks.count).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ userId: 'account-b' }) }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('gestisce due richieste concorrenti al quarantesimo posto con retry serializzabile', async () => {
    let monthlyCount = 39;
    let transactionAttempt = 0;
    let concurrentReads = 0;
    let stagedCreates = 0;
    let releaseConcurrentReads: (() => void) | undefined;
    const concurrentReadBarrier = new Promise<void>((resolve) => {
      releaseConcurrentReads = resolve;
    });
    mocks.transaction.mockImplementation(async (operation: MockTransactionOperation) => {
      const attempt = transactionAttempt;
      transactionAttempt += 1;
      const snapshot = monthlyCount;
      let stagedEntry: EntryRow | null = null;
      const transaction: MockTransactionClient = {
        listeningEntry: {
          count: vi.fn(async () => {
            if (attempt < 2) {
              concurrentReads += 1;
              if (concurrentReads === 2) releaseConcurrentReads?.();
              await concurrentReadBarrier;
            }
            return snapshot;
          }),
          create: vi.fn(async (args: { data: CreateData }) => {
            stagedCreates += 1;
            stagedEntry = {
              id: `entry-staged-${stagedCreates}`,
              ...args.data,
              updatedAt: args.data.createdAt,
            };
            return stagedEntry;
          }),
        },
      };

      const result = await operation(transaction);
      if (stagedEntry) {
        if (monthlyCount !== snapshot) {
          throw Object.assign(new Error('Serialization conflict'), { code: 'P2034' });
        }
        monthlyCount += 1;
      }
      return result;
    });

    const responses = await Promise.all([POST(createRequest()), POST(createRequest())]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(monthlyCount).toBe(40);
    expect(transactionAttempt).toBe(3);
    expect(stagedCreates).toBe(2);
  });

  it('restituisce il conteggio mensile isolato per account e createdAt', async () => {
    mocks.count.mockResolvedValue(7);
    const response = await GETUsage(request('/api/listening-entries/usage'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.usage).toMatchObject({ used: 7, limit: 40, remaining: 33 });
    expect(mocks.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'account-a',
          createdAt: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }),
        }),
      }),
    );
  });

  it('riparte dal nuovo mese italiano nel conteggio della route usage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T22:00:00.000Z'));
    mocks.count.mockResolvedValue(0);

    try {
      const response = await GETUsage(request('/api/listening-entries/usage'));
      const body = await response.json();
      const countArgs = mocks.count.mock.calls[0]?.[0];

      expect(response.status).toBe(200);
      expect(body.usage).toMatchObject({ month: 'aprile 2026', used: 0, limit: 40, remaining: 40 });
      expect(countArgs.where.createdAt.gte.toISOString()).toBe('2026-03-31T22:00:00.000Z');
      expect(countArgs.where.createdAt.lt.toISOString()).toBe('2026-04-30T22:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('non modifica un ascolto appartenente a un altro account', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const response = await PATCH(
      request('/api/listening-entries/entry-b', {
        method: 'PATCH',
        headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 4 }),
      }),
      { params: Promise.resolve({ entryId: 'entry-b' }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'entry-b', userId: 'account-a' } }));
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('aggiorna i campi del diario senza ripubblicare i metadati della copertina', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findFirst.mockResolvedValue(rows[0]);
    const response = await PATCH(
      request('/api/listening-entries/entry-a', {
        method: 'PATCH',
        headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 5, note: 'Nuova nota', listenedOn: '2026-11-08', context: 'casa' }),
      }),
      { params: Promise.resolve({ entryId: 'entry-a' }) },
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.entry).toMatchObject({
      id: 'entry-a',
      albumId: '101',
      catalogProvider: 'legacy',
      albumName: 'Album A',
      artistName: 'Artista A',
      artworkUrl: null,
      releaseDate: '2007-10-10T07:00:00Z',
      genre: 'Alternative',
      trackCount: 10,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'entry-a', userId: 'account-a' },
      data: { rating: 5, note: 'Nuova nota', listenedOn: expect.any(Date), context: 'casa' },
    }));
  });
});
