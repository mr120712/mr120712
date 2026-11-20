// @polsia:user-owned — rotta /api/telegram/link: GET stato, POST mint del codice (deep-link), DELETE
// scollega. Auth + sameOrigin mockati; nessuna rete né DB reale.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(() => true),
  botConfigured: vi.fn(() => true),
  createChallenge: vi.fn(),
  findUnique: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  isTelegramBotConfigured: mocks.botConfigured,
}));
vi.mock('@/lib/business/telegram-link', () => ({
  createTelegramLinkChallenge: mocks.createChallenge,
  LINK_CODE_TTL_MS: 900_000,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    telegramAccountLink: { findUnique: mocks.findUnique, deleteMany: mocks.deleteMany },
  },
}));

import { DELETE, GET, POST } from '@/app/api/telegram/link/route';

const USER = { id: 'user-1', email: 'a@b.it' };
const ORIGINAL_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

function req(method: string) {
  return new Request('https://solco.example/api/telegram/link', { method });
}
function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.botConfigured.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue(USER);
  process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = 'solco_bot';
});

afterEach(() => {
  if (ORIGINAL_BOT === undefined) delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  else process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME = ORIGINAL_BOT;
});

describe('POST /api/telegram/link (mint)', () => {
  it('403 da origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(req('POST'))).status).toBe(403);
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });

  it('503 se il bot non è configurato o manca lo username', async () => {
    mocks.botConfigured.mockReturnValue(false);
    expect((await POST(req('POST'))).status).toBe(503);
    mocks.botConfigured.mockReturnValue(true);
    delete process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
    expect((await POST(req('POST'))).status).toBe(503);
    expect(mocks.createChallenge).not.toHaveBeenCalled();
  });

  it('401 senza accesso', async () => {
    mocks.requireAuth.mockRejectedValue(unauthorized());
    expect((await POST(req('POST'))).status).toBe(401);
  });

  it('200 → deep-link col codice e scadenza; lega il codice allo userId della sessione', async () => {
    mocks.createChallenge.mockResolvedValue('CODE_123-xyz');
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://t.me/solco_bot?start=CODE_123-xyz');
    expect(typeof body.expiresAt).toBe('number');
    expect(mocks.createChallenge).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });
});

describe('GET /api/telegram/link (stato)', () => {
  it('401 senza accesso', async () => {
    mocks.requireAuth.mockRejectedValue(unauthorized());
    expect((await GET(req('GET'))).status).toBe(401);
  });

  it('collegato → { linked:true, username }', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1', telegramUsername: 'tg' });
    const body = await (await GET(req('GET'))).json();
    expect(body).toEqual({ linked: true, username: 'tg' });
  });

  it('non collegato → { linked:false, username:null }', async () => {
    mocks.findUnique.mockResolvedValue(null);
    const body = await (await GET(req('GET'))).json();
    expect(body).toEqual({ linked: false, username: null });
  });
});

describe('DELETE /api/telegram/link (scollega)', () => {
  it('403 da origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await DELETE(req('DELETE'))).status).toBe(403);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it('200 e rimuove il collegamento dell’utente', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(req('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, username: null });
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});
