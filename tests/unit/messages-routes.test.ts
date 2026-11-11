// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/require-auth';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  conversationFindMany: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationUpsert: vi.fn(),
  conversationUpdate: vi.fn(),
  conversationUpdateMany: vi.fn(),
  messageCreate: vi.fn(),
  profileFindUnique: vi.fn(),
  profileFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  transaction: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/db', () => ({
  prisma: {
    conversation: {
      findMany: mocks.conversationFindMany,
      findFirst: mocks.conversationFindFirst,
      upsert: mocks.conversationUpsert,
      update: mocks.conversationUpdate,
      updateMany: mocks.conversationUpdateMany,
    },
    message: { create: mocks.messageCreate },
    userProfile: {
      findUnique: mocks.profileFindUnique,
      findMany: mocks.profileFindMany,
    },
    user: {
      findUnique: mocks.userFindUnique,
      findMany: mocks.userFindMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET as getThread, POST as sendMessage } from '@/app/api/messages/[conversationId]/route';
import { GET as getInbox, POST as startConversation } from '@/app/api/messages/route';

type TestUser = { id: string; name: string };
type TestMessage = { id: string; senderId: string; content: string; createdAt: Date };
type TestConversation = {
  id: string;
  participantAId: string;
  participantBId: string;
  lastMessageAt: Date;
  messages: TestMessage[];
};
type TransactionClient = {
  conversation: {
    upsert: typeof mocks.conversationUpsert;
    update: typeof mocks.conversationUpdate;
    updateMany: typeof mocks.conversationUpdateMany;
  };
  message: { create: typeof mocks.messageCreate };
};

const alice = { id: 'user-a', name: 'Alice' } as unknown as SessionUser;
const ben = { id: 'user-b', name: 'Ben' } as unknown as SessionUser;
const stranger = { id: 'user-c', name: 'Carlo' } as unknown as SessionUser;
const time1 = new Date('2026-11-01T10:00:00.000Z');
const time2 = new Date('2026-11-01T10:05:00.000Z');
const conversation: TestConversation = {
  id: 'thread-ab',
  participantAId: alice.id,
  participantBId: ben.id,
  lastMessageAt: time2,
  messages: [
    { id: 'message-1', senderId: alice.id, content: 'Ciao Ben', createdAt: time1 },
    { id: 'message-2', senderId: ben.id, content: 'Ciao Alice', createdAt: time2 },
  ],
};

function request(path: string, init?: RequestInit) {
  return new Request(`https://solco.test${path}`, init);
}

function sendRequest(content: unknown, origin = 'https://solco.test') {
  return request('/api/messages/thread-ab', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(content),
  });
}

function params(id = conversation.id) {
  return { params: Promise.resolve({ conversationId: id }) };
}

describe('messaggi privati', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sameOrigin.mockReturnValue(true);
    mocks.requireAuth.mockResolvedValue(alice);
    mocks.enforceRateLimit.mockResolvedValue(null);
    mocks.conversationFindMany.mockResolvedValue([
      { ...conversation, messages: [...conversation.messages].reverse() },
    ]);
    mocks.conversationFindFirst.mockImplementation(
      async (args: { where: { OR: Array<Record<string, string>> } }) => {
        const requestedUserId =
          args.where.OR[0]?.participantAId ?? args.where.OR[1]?.participantBId;
        return requestedUserId === alice.id || requestedUserId === ben.id ? conversation : null;
      },
    );
    mocks.conversationUpsert.mockResolvedValue(conversation);
    mocks.conversationUpdate.mockResolvedValue(conversation);
    mocks.conversationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.profileFindUnique.mockResolvedValue({
      id: 'profile-b',
      userId: ben.id,
      profileVisibility: 'public',
    });
    mocks.profileFindMany.mockResolvedValue([
      { userId: alice.id, profileRole: 'fan' },
      { userId: ben.id, profileRole: 'artist' },
    ]);
    mocks.userFindUnique.mockResolvedValue({ id: ben.id });
    mocks.userFindMany.mockResolvedValue([
      { id: alice.id, name: 'Alice' },
      { id: ben.id, name: 'Ben' },
    ] satisfies TestUser[]);
    mocks.messageCreate.mockImplementation(
      async (args: { data: Omit<TestMessage, 'id' | 'createdAt'> & { createdAt?: Date } }) => ({
        id: 'message-new',
        senderId: args.data.senderId,
        content: args.data.content,
        createdAt: args.data.createdAt ?? time2,
      }),
    );
    const transactionClient: TransactionClient = {
      conversation: {
        upsert: mocks.conversationUpsert,
        update: mocks.conversationUpdate,
        updateMany: mocks.conversationUpdateMany,
      },
      message: { create: mocks.messageCreate },
    };
    mocks.transaction.mockImplementation(
      async (operation: (tx: TransactionClient) => Promise<unknown>) =>
        operation(transactionClient),
    );
  });

  it('accesso ai messaggi solo ai partecipanti', async () => {
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await getInbox(request('/api/messages'))).status).toBe(401);
    expect((await getThread(request('/api/messages/thread-ab'), params())).status).toBe(401);
    expect((await sendMessage(sendRequest({ content: 'Ciao' }), params())).status).toBe(401);
    expect(mocks.conversationFindMany).not.toHaveBeenCalled();
    expect(mocks.conversationFindFirst).not.toHaveBeenCalled();

    mocks.requireAuth.mockResolvedValue(alice);
    const readByAlice = await getThread(request('/api/messages/thread-ab'), params());
    expect(readByAlice.status).toBe(200);
    expect((await readByAlice.json()).messages).toHaveLength(2);
    expect(
      (await sendMessage(sendRequest({ content: 'Risposta di Alice' }), params())).status,
    ).toBe(201);

    mocks.requireAuth.mockResolvedValue(ben);
    const readByBen = await getThread(request('/api/messages/thread-ab'), params());
    expect(readByBen.status).toBe(200);
    expect(
      (await readByBen.json()).messages.map((message: TestMessage) => message.content),
    ).toEqual(['Ciao Ben', 'Ciao Alice']);
    expect((await sendMessage(sendRequest({ content: 'Risposta di Ben' }), params())).status).toBe(
      201,
    );

    mocks.requireAuth.mockResolvedValue(stranger);
    const thirdPartyRead = await getThread(request('/api/messages/thread-ab'), params());
    expect(thirdPartyRead.status).toBe(404);
    expect(await thirdPartyRead.json()).toEqual({ error: 'Conversazione non disponibile.' });
    const beforeDeniedSendCount = mocks.messageCreate.mock.calls.length;
    const thirdPartySend = await sendMessage(sendRequest({ content: 'Segreto' }), params());
    expect(thirdPartySend.status).toBe(404);
    expect(await thirdPartySend.json()).toEqual({ error: 'Conversazione non disponibile.' });
    expect(mocks.messageCreate).toHaveBeenCalledTimes(beforeDeniedSendCount);
  });

  it('nega origini non ammesse e contenuti non validi prima di scrivere', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const deniedOrigin = await startConversation(
      request('/api/messages', {
        method: 'POST',
        headers: { origin: 'https://altra-origine.test', 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: 'profile-b', content: 'Ciao' }),
      }),
    );
    expect(deniedOrigin.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValue(true);
    const invalid = await startConversation(
      request('/api/messages', {
        method: 'POST',
        headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: 'profile-b', content: '   ' }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('riusa un unico thread per lo stesso profilo e aggiorna il messaggio più recente', async () => {
    const response = await startConversation(
      request('/api/messages', {
        method: 'POST',
        headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: 'profile-b', content: '  Ciao di nuovo  ' }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      conversationId: 'thread-ab',
      message: { content: 'Ciao di nuovo' },
    });
    expect(mocks.conversationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          participantAId_participantBId: { participantAId: alice.id, participantBId: ben.id },
        },
      }),
    );
    expect(mocks.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conversationId: conversation.id, senderId: alice.id }),
      }),
    );
  });

  it('restituisce 429 prima di creare una conversazione e non applica un limite globale', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json(
        { error: 'rate_limited', message: 'Riprova tra 60 secondi.', retryAfterSeconds: 60 },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    );

    const blocked = await startConversation(
      request('/api/messages', {
        method: 'POST',
        headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: 'profile-b', content: 'Ciao' }),
      }),
    );

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.requireAuth.mockResolvedValue(ben);
    const otherAccount = await sendMessage(sendRequest({ content: 'Ciao Alice' }), params());
    expect(otherAccount.status).toBe(201);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('messages.send', `user:${ben.id}`);
  });

  it('rifiuta un corpo troppo grande e verifica i partecipanti prima di consumare il budget', async () => {
    const oversized = await sendMessage(sendRequest({ content: 'x'.repeat(30_000) }), params());
    expect(oversized.status).toBe(413);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();

    mocks.requireAuth.mockResolvedValue(stranger);
    const unauthorizedConversation = await sendMessage(
      sendRequest({ content: 'Non mio' }),
      params(),
    );
    expect(unauthorizedConversation.status).toBe(404);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it('restituisce solo le conversazioni dell’account e il ruolo pubblico dell’interlocutore', async () => {
    const response = await getInbox(request('/api/messages'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversations: [
        {
          id: conversation.id,
          participant: { id: ben.id, name: 'Ben', role: 'artist' },
          lastMessage: { content: 'Ciao Alice' },
        },
      ],
    });
    expect(mocks.conversationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ participantAId: alice.id }, { participantBId: alice.id }] },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'asc' }],
      }),
    );
  });

  it('lascia fuori dai budget le letture ordinarie della inbox e della conversazione', async () => {
    const inbox = await getInbox(request('/api/messages'));
    const thread = await getThread(request('/api/messages/thread-ab'), params());

    expect(inbox.status).toBe(200);
    expect(thread.status).toBe(200);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });
});
