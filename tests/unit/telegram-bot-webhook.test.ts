// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  env: { TELEGRAM_WEBHOOK_SECRET: 'sec' as string | undefined, TELEGRAM_BOT_TOKEN: 'tok' },
  configured: true,
  send: vi.fn(async (_chatId?: string, _text?: string, _options?: unknown) => true),
  ensureCode: vi.fn(async (_userId?: string) => 'ABC123'),
  verify: vi.fn(),
  readJson: vi.fn(),
  deleteMany: vi.fn(async () => ({})),
  upsert: vi.fn(async () => ({})),
  findUnique: vi.fn(),
  enforceRateLimit: vi.fn(),
  botSearch: vi.fn(async (_query?: string) => [] as unknown[]),
}));

vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/music/bot-search.server', () => ({ botSearch: mocks.botSearch }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  sendTelegramMessage: mocks.send,
  isTelegramBotConfigured: () => mocks.configured,
  inviteLinkForCode: (code: string) => `https://solco.test/invito/${code}`,
  escapeTelegramHtml: (s: string) => s,
  inviteKeyboard: () => ({ kind: 'invite' }),
  miniAppKeyboard: () => ({ kind: 'mini' }),
  searchKeyboard: () => ({ kind: 'search' }),
}));
vi.mock('@/lib/business/rewards.server', () => ({ ensureReferralCode: mocks.ensureCode }));
vi.mock('@/lib/business/telegram-link', () => ({ verifyTelegramLinkToken: mocks.verify }));
vi.mock('@/lib/business/request-body.server', () => ({ readJsonLimited: mocks.readJson }));
vi.mock('@/lib/db', () => ({
  prisma: {
    telegramAccountLink: {
      deleteMany: mocks.deleteMany,
      upsert: mocks.upsert,
      findUnique: mocks.findUnique,
    },
  },
}));

import { POST } from '@/app/api/telegram/webhook/route';

function req(update: unknown, secretHeader: string | null = 'sec') {
  mocks.readJson.mockResolvedValue({ ok: true, value: update });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secretHeader !== null) headers['x-telegram-bot-api-secret-token'] = secretHeader;
  return new Request('https://solco.test/api/telegram/webhook', {
    method: 'POST',
    headers,
    body: '{}',
  });
}
const msg = (text: string) => ({
  message: { text, chat: { id: 123, type: 'private' }, from: { username: 'u' } },
});

function lastSend() {
  const call = mocks.send.mock.calls[0];
  return {
    text: String(call?.[1] ?? ''),
    options: (call?.[2] ?? {}) as { parseMode?: string; replyMarkup?: unknown },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.TELEGRAM_WEBHOOK_SECRET = 'sec';
  mocks.configured = true;
  mocks.send.mockResolvedValue(true);
  mocks.ensureCode.mockResolvedValue('ABC123');
  mocks.findUnique.mockResolvedValue(null);
  mocks.verify.mockReturnValue(null);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.botSearch.mockResolvedValue([]);
});

describe('POST /api/telegram/webhook (bot)', () => {
  it('404 se il bot non è configurato', async () => {
    mocks.configured = false;
    expect((await POST(req(msg('/codice')))).status).toBe(404);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('404 se manca il webhook secret', async () => {
    mocks.env.TELEGRAM_WEBHOOK_SECRET = undefined;
    expect((await POST(req(msg('/codice')))).status).toBe(404);
  });

  it('401 con secret header errato', async () => {
    expect((await POST(req(msg('/codice'), 'altro'))).status).toBe(401);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('401 con secret di lunghezza diversa (confronto a tempo costante non lancia)', async () => {
    expect((await POST(req(msg('/codice'), 'x'))).status).toBe(401);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('oltre il rate-limit per chat: scarta (200, nessuna elaborazione)', async () => {
    mocks.enforceRateLimit.mockResolvedValue(new Response('slow down', { status: 429 }));
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    const res = await POST(req(msg('/codice')));
    expect(res.status).toBe(200);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.ensureCode).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('telegram.webhook', 'tg:123');
  });

  it('/codice da utente collegato: invia il codice con tastiera invito in HTML', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    const res = await POST(req(msg('/codice')));
    expect(res.status).toBe(200);
    expect(mocks.ensureCode).toHaveBeenCalledWith('user-1');
    const { text, options } = lastSend();
    expect(text).toContain('ABC123');
    expect(options.parseMode).toBe('HTML');
    expect(options.replyMarkup).toEqual({ kind: 'invite' });
  });

  it('/codice da utente NON collegato: invito a collegarsi + tastiera Apri Solco', async () => {
    const res = await POST(req(msg('/codice')));
    expect(res.status).toBe(200);
    const { text, options } = lastSend();
    expect(text).toContain('collega il tuo account');
    expect(options.replyMarkup).toEqual({ kind: 'mini' });
  });

  it('/help: messaggio di aiuto in HTML', async () => {
    await POST(req(msg('/help')));
    const { text, options } = lastSend();
    expect(text).toContain('Ecco cosa posso fare');
    expect(options.parseMode).toBe('HTML');
  });

  it('/start <token> valido: collega l’account e manda il codice', async () => {
    mocks.verify.mockReturnValue('user-9');
    await POST(req(msg('/start tok123')));
    expect(mocks.deleteMany).toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalled();
    expect(mocks.ensureCode).toHaveBeenCalledWith('user-9');
    expect(lastSend().text).toContain('Account collegato');
  });

  it('/cerca <parole>: cerca CC e risponde con i risultati + tastiera di ascolto', async () => {
    mocks.botSearch.mockResolvedValue([
      {
        kind: 'audius',
        key: 'audius:1',
        score: 100,
        track: { title: 'Alba', artistName: 'Artista' },
        youtubeAlternative: null,
      },
      { kind: 'radio', key: 'radio:1', score: 80, station: { name: 'Indie FM' } },
    ]);
    await POST(req(msg('/cerca lofi')));
    expect(mocks.botSearch).toHaveBeenCalledWith('lofi');
    const { text, options } = lastSend();
    expect(text).toContain('Alba');
    expect(text).toContain('Indie FM');
    expect(options.parseMode).toBe('HTML');
    expect(options.replyMarkup).toEqual({ kind: 'search' });
  });

  it('/cerca senza parole: mostra l’uso, non cerca', async () => {
    await POST(req(msg('/cerca')));
    expect(mocks.botSearch).not.toHaveBeenCalled();
    expect(lastSend().text).toContain('/cerca parole');
  });

  it('/cerca senza risultati: lo dice, non cerca a vuoto', async () => {
    mocks.botSearch.mockResolvedValue([]);
    await POST(req(msg('/cerca xyzqwkk')));
    expect(mocks.botSearch).toHaveBeenCalledWith('xyzqwkk');
    expect(lastSend().text).toContain('Nessun brano');
  });

  it('/app: invita ad aprire la Mini App', async () => {
    await POST(req(msg('/app')));
    const { text, options } = lastSend();
    expect(text).toContain('Mini App');
    expect(options.replyMarkup).toEqual({ kind: 'mini' });
    expect(mocks.botSearch).not.toHaveBeenCalled();
  });
});
