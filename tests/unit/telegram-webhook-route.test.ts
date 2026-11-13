// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  configured: true,
  secret: 'sek' as string | undefined,
  readJson: vi.fn(),
  verifyToken: vi.fn(),
  ensureCode: vi.fn(),
  send: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  get env() {
    return { TELEGRAM_WEBHOOK_SECRET: mocks.secret, TELEGRAM_BOT_TOKEN: 'tok' };
  },
}));
vi.mock('@/lib/business/request-body.server', () => ({ readJsonLimited: mocks.readJson }));
vi.mock('@/lib/business/rewards.server', () => ({ ensureReferralCode: mocks.ensureCode }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  isTelegramBotConfigured: () => mocks.configured,
  sendTelegramMessage: mocks.send,
  inviteLinkForCode: (code: string) => `https://solco.example/invito/${code}`,
}));
vi.mock('@/lib/business/telegram-link', () => ({ verifyTelegramLinkToken: mocks.verifyToken }));
vi.mock('@/lib/db', () => ({
  prisma: {
    telegramAccountLink: {
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
      findUnique: mocks.findUnique,
    },
  },
}));

import { POST } from '@/app/api/telegram/webhook/route';

function req(secretHeader?: string) {
  const headers: Record<string, string> = {};
  if (secretHeader !== undefined) headers['x-telegram-bot-api-secret-token'] = secretHeader;
  return new Request('https://solco.example/api/telegram/webhook', { method: 'POST', headers });
}
function update(text: string, chatId: number | string = 555, username = 'mario') {
  return { ok: true, value: { message: { text, chat: { id: chatId }, from: { username } } } };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured = true;
  mocks.secret = 'sek';
  mocks.ensureCode.mockResolvedValue('ABCD1234');
  mocks.send.mockResolvedValue(true);
  mocks.readJson.mockResolvedValue(update('/codice'));
});

describe('POST /api/telegram/webhook', () => {
  it('404 se bot/secret non configurati', async () => {
    mocks.configured = false;
    expect((await POST(req('sek'))).status).toBe(404);
    mocks.configured = true;
    mocks.secret = undefined;
    expect((await POST(req('sek'))).status).toBe(404);
  });

  it('401 se il secret header è sbagliato o assente', async () => {
    expect((await POST(req('sbagliato'))).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
    expect(mocks.readJson).not.toHaveBeenCalled();
  });

  it('/start <token> valido → collega l’account e invia il codice', async () => {
    mocks.verifyToken.mockReturnValue('user-9');
    mocks.readJson.mockResolvedValue(update('/start LINKTOKEN'));
    const res = await POST(req('sek'));
    expect(res.status).toBe(200);
    expect(mocks.deleteMany).toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-9' },
        create: expect.objectContaining({ userId: 'user-9', telegramChatId: '555' }),
      }),
    );
    expect(mocks.send).toHaveBeenCalledWith('555', expect.stringContaining('ABCD1234'));
  });

  it('/start <token> non valido → messaggio di errore, nessun collegamento', async () => {
    mocks.verifyToken.mockReturnValue(null);
    mocks.readJson.mockResolvedValue(update('/start SCADUTO'));
    await POST(req('sek'));
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith('555', expect.stringMatching(/scaduto|non valido/i));
  });

  it('/codice quando già collegato → invia il codice', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-7' });
    mocks.readJson.mockResolvedValue(update('/codice'));
    await POST(req('sek'));
    expect(mocks.ensureCode).toHaveBeenCalledWith('user-7');
    expect(mocks.send).toHaveBeenCalledWith('555', expect.stringContaining('ABCD1234'));
  });

  it('/codice senza collegamento → spiega come collegare', async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.readJson.mockResolvedValue(update('/codice'));
    await POST(req('sek'));
    expect(mocks.ensureCode).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith('555', expect.stringMatching(/collega/i));
  });
});
