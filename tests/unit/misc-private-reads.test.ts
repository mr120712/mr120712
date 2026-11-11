// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationFindMany: vi.fn(),
  messageFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  profileFindMany: vi.fn(),
  ensureCommunityProfile: vi.fn(),
  profileCounts: vi.fn(),
  getSession: vi.fn(),
  productFindFirst: vi.fn(),
  checkCreate: vi.fn(),
  checkUpdate: vi.fn(),
  fetchPage: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/business/community.server', () => ({
  ensureCommunityProfile: mocks.ensureCommunityProfile,
  profileCounts: mocks.profileCounts,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    conversation: { findFirst: mocks.conversationFindFirst, findMany: mocks.conversationFindMany },
    message: { findFirst: mocks.messageFindFirst },
    user: { findMany: mocks.userFindMany },
    userProfile: { findMany: mocks.profileFindMany },
    product: { findFirst: mocks.productFindFirst },
    productCheck: { create: mocks.checkCreate, update: mocks.checkUpdate },
  },
}));
vi.mock('@/lib/ai/client', () => ({ generateObject: mocks.generateObject }));
vi.mock('@/modules/web-search/client', () => ({
  fetchPage: mocks.fetchPage,
  InvalidUrlError: class InvalidUrlError extends Error {},
  PageUnavailableError: class PageUnavailableError extends Error {},
  QuotaExceededError: class QuotaExceededError extends Error {},
  WebSearchConfigurationError: class WebSearchConfigurationError extends Error {},
  WebSearchError: class WebSearchError extends Error {},
  WebSearchNotEnabledError: class WebSearchNotEnabledError extends Error {},
  WebSearchUnavailableError: class WebSearchUnavailableError extends Error {},
}));

import { GET as getMe } from '@/app/api/community/me/route';
import { GET as getThread } from '@/app/api/messages/[conversationId]/route';
import { GET as getInbox } from '@/app/api/messages/route';
import { POST as startCheck } from '@/app/api/products/[productId]/checks/route';

const alice = { id: 'user-a', name: 'Alice' };
const ben = { id: 'user-b', name: 'Ben' };
const start = Date.parse('2026-11-01T10:00:00.000Z');

function message(index: number) {
  return {
    id: `message-${String(index).padStart(4, '0')}`,
    conversationId: 'thread-ab',
    senderId: index % 2 === 0 ? alice.id : ben.id,
    content: `Messaggio ${index}`,
    createdAt: new Date(start + index * 1000),
  };
}

function threadWith(messages: ReturnType<typeof message>[]) {
  return {
    id: 'thread-ab',
    participantAId: alice.id,
    participantBId: ben.id,
    lastMessageAt: new Date(start),
    messages,
  };
}

const params = { params: Promise.resolve({ conversationId: 'thread-ab' }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue(alice);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.userFindMany.mockResolvedValue([ben]);
  mocks.profileFindMany.mockResolvedValue([{ userId: ben.id, profileRole: 'artist' }]);
  mocks.conversationFindMany.mockResolvedValue([]);
});

describe('conversazione: pagine degli ultimi messaggi', () => {
  it('carica al massimo gli ultimi 200 messaggi in ordine cronologico', async () => {
    // The database returns the newest 201 rows first; the 201st only signals older messages.
    const newestFirst = Array.from({ length: 201 }, (_, index) => message(300 - index));
    mocks.conversationFindFirst.mockResolvedValue(threadWith(newestFirst));

    const response = await getThread(
      new Request('https://solco.test/api/messages/thread-ab'),
      params,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.conversationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          messages: expect.objectContaining({
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 201,
          }),
        },
      }),
    );
    expect(body.messages).toHaveLength(200);
    expect(body.messages[0].content).toBe('Messaggio 101');
    expect(body.messages[199].content).toBe('Messaggio 300');
    expect(body.hasMore).toBe(true);
    expect(body.nextBefore).toBe('message-0101');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
  });

  it('segnala la fine del thread quando non ci sono messaggi più vecchi', async () => {
    mocks.conversationFindFirst.mockResolvedValue(threadWith([message(2), message(1)]));

    const response = await getThread(
      new Request('https://solco.test/api/messages/thread-ab'),
      params,
    );
    const body = await response.json();

    expect(body.messages.map((item: { content: string }) => item.content)).toEqual([
      'Messaggio 1',
      'Messaggio 2',
    ]);
    expect(body.hasMore).toBe(false);
    expect(body.nextBefore).toBeNull();
  });

  it('legge i messaggi precedenti solo da un cursore della stessa conversazione', async () => {
    const cursor = message(101);
    mocks.messageFindFirst.mockResolvedValue({ id: cursor.id, createdAt: cursor.createdAt });
    mocks.conversationFindFirst.mockResolvedValue(threadWith([message(100), message(99)]));

    const response = await getThread(
      new Request(`https://solco.test/api/messages/thread-ab?before=${cursor.id}`),
      params,
    );

    expect(response.status).toBe(200);
    expect(mocks.messageFindFirst).toHaveBeenCalledWith({
      where: {
        id: cursor.id,
        conversation: {
          id: 'thread-ab',
          OR: [{ participantAId: alice.id }, { participantBId: alice.id }],
        },
      },
      select: { id: true, createdAt: true },
    });
    expect(mocks.conversationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          messages: expect.objectContaining({
            where: {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          }),
        },
      }),
    );
  });

  it('rifiuta cursori non validi o di altre conversazioni senza leggere il thread', async () => {
    const malformed = await getThread(
      new Request('https://solco.test/api/messages/thread-ab?before=..%2Fx'),
      params,
    );
    expect(malformed.status).toBe(400);
    expect(mocks.messageFindFirst).not.toHaveBeenCalled();

    mocks.messageFindFirst.mockResolvedValue(null);
    const foreign = await getThread(
      new Request('https://solco.test/api/messages/thread-ab?before=message-other'),
      params,
    );
    expect(foreign.status).toBe(400);
    expect(mocks.conversationFindFirst).not.toHaveBeenCalled();
  });

  it('invia inbox e profilo personale senza cache condivisa', async () => {
    const inbox = await getInbox(new Request('https://solco.test/api/messages'));
    expect(inbox.status).toBe(200);
    expect(inbox.headers.get('cache-control')).toBe('private, no-store');
    expect(inbox.headers.get('vary')).toBe('Cookie');

    mocks.ensureCommunityProfile.mockResolvedValue({
      id: 'profile-a',
      profileRole: 'fan',
      profileVisibility: 'private',
      followersVisibility: 'private',
      followingVisibility: 'private',
    });
    mocks.profileCounts.mockResolvedValue({ followers: new Map(), following: new Map() });
    const me = await getMe(new Request('https://solco.test/api/community/me'));
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('private, no-store');
    expect(me.headers.get('vary')).toBe('Cookie');
  });
});

describe('controlli prodotto: tetto giornaliero dell’app', () => {
  const product = {
    id: 'product-1',
    name: 'Album',
    url: 'https://shop.example.test/album',
    expectedPriceCents: 2500,
    expectedAvailability: true,
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  };
  const productParams = { params: Promise.resolve({ productId: product.id }) };

  function checkRequest() {
    return new Request('https://solco.test/api/products/product-1/checks', {
      method: 'POST',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: '{}',
    });
  }

  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.productFindFirst.mockResolvedValue(product);
  });

  it('applica product.check.global dopo il limite per account e prima di lettura web e AI', async () => {
    mocks.enforceRateLimit
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        Response.json(
          { error: 'rate_limited', message: 'Riprova più tardi.', retryAfterSeconds: 3600 },
          { status: 429, headers: { 'Retry-After': '3600' } },
        ),
      );

    const response = await startCheck(checkRequest(), productParams);

    expect(response.status).toBe(429);
    expect(mocks.enforceRateLimit.mock.calls).toEqual([
      ['product.check.start', 'user:user-1'],
      ['product.check.global', 'global'],
    ]);
    expect(mocks.checkCreate).not.toHaveBeenCalled();
    expect(mocks.fetchPage).not.toHaveBeenCalled();
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it('non consuma il tetto globale quando l’account è già bloccato', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } }),
    );

    const response = await startCheck(checkRequest(), productParams);

    expect(response.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('product.check.start', 'user:user-1');
  });
});
