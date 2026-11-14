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
  sendAudio: vi.fn(async (_chatId?: string, _url?: string, _opts?: unknown) => true),
  listUploads: vi.fn(async (_userId?: string) => [] as Array<{ id: string; title: string }>),
  getUpload: vi.fn(
    async (_userId?: string, _id?: string) =>
      null as { blobUrl: string; title: string; mimeType: string } | null,
  ),
  answerCallback: vi.fn(async (_id?: string) => undefined),
}));

vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/music/bot-search.server', () => ({ botSearch: mocks.botSearch }));
vi.mock('@/lib/music/public-uploads.server', () => ({
  listMyPublicUploads: mocks.listUploads,
  getOwnUploadForDownload: mocks.getUpload,
}));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  sendTelegramMessage: mocks.send,
  sendTelegramAudio: mocks.sendAudio,
  isTelegramBotConfigured: () => mocks.configured,
  inviteLinkForCode: (code: string) => `https://solco.test/invito/${code}`,
  escapeTelegramHtml: (s: string) => s,
  inviteKeyboard: () => ({ kind: 'invite' }),
  miniAppKeyboard: () => ({ kind: 'mini' }),
  searchKeyboard: () => ({ kind: 'search' }),
  menuKeyboard: () => ({ kind: 'menu' }),
  answerTelegramCallback: mocks.answerCallback,
  TELEGRAM_MENU_CALLBACKS: {
    'menu:cerca': '/cerca',
    'menu:scarica': '/scarica',
    'menu:codice': '/codice',
  },
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
const groupMsg = (text: string) => ({
  message: { text, chat: { id: 123, type: 'supergroup' }, from: { username: 'u' } },
});
const callbackUpdate = (data: string, type: 'private' | 'supergroup' = 'private') => ({
  callback_query: {
    id: 'cb-1',
    data,
    from: { username: 'u' },
    message: { chat: { id: 123, type } },
  },
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
  mocks.sendAudio.mockResolvedValue(true);
  mocks.listUploads.mockResolvedValue([]);
  mocks.getUpload.mockResolvedValue(null);
  mocks.answerCallback.mockResolvedValue(undefined);
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

  it('/cerca: tronca titoli lunghi (resta sotto il limite di 4096 di Telegram)', async () => {
    const longTitle = 'A'.repeat(400);
    mocks.botSearch.mockResolvedValue([
      {
        kind: 'audius',
        key: 'audius:1',
        score: 100,
        track: { title: longTitle, artistName: 'X' },
        youtubeAlternative: null,
      },
    ]);
    await POST(req(msg('/cerca test')));
    const { text } = lastSend();
    expect(text).not.toContain(longTitle);
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(4096);
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

  it('/menu: mostra il menu con la tastiera dei pulsanti', async () => {
    await POST(req(msg('/menu')));
    const { text, options } = lastSend();
    expect(text).toContain('Menu');
    expect(options.parseMode).toBe('HTML');
    expect(options.replyMarkup).toEqual({ kind: 'menu' });
  });

  it('callback menu:codice (utente collegato): chiude lo spinner e invia il codice', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    const res = await POST(req(callbackUpdate('menu:codice')));
    expect(res.status).toBe(200);
    expect(mocks.answerCallback).toHaveBeenCalledWith('cb-1');
    expect(mocks.ensureCode).toHaveBeenCalledWith('user-1');
    expect(lastSend().text).toContain('ABC123');
  });

  it('callback menu:scarica in un gruppo: la guardia chat-privata rifiuta (niente brani)', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([{ id: 'a', title: 'Primo' }]);
    await POST(req(callbackUpdate('menu:scarica', 'supergroup')));
    expect(mocks.answerCallback).toHaveBeenCalledWith('cb-1');
    expect(mocks.listUploads).not.toHaveBeenCalled();
    expect(mocks.sendAudio).not.toHaveBeenCalled();
    expect(lastSend().text).toContain('in privato');
  });

  it('callback con data sconosciuta: chiude lo spinner e non fa altro', async () => {
    const res = await POST(req(callbackUpdate('menu:boh')));
    expect(res.status).toBe(200);
    expect(mocks.answerCallback).toHaveBeenCalledWith('cb-1');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('callback oltre il rate-limit: scartato, nessun answerCallback né elaborazione', async () => {
    mocks.enforceRateLimit.mockResolvedValue(new Response('slow', { status: 429 }));
    const res = await POST(req(callbackUpdate('menu:codice')));
    expect(res.status).toBe(200);
    expect(mocks.answerCallback).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('/app: invita ad aprire la Mini App', async () => {
    await POST(req(msg('/app')));
    const { text, options } = lastSend();
    expect(text).toContain('Mini App');
    expect(options.replyMarkup).toEqual({ kind: 'mini' });
    expect(mocks.botSearch).not.toHaveBeenCalled();
  });

  it('/scarica da chat NON collegata: invita a collegarsi, non tocca gli upload', async () => {
    mocks.findUnique.mockResolvedValue(null);
    await POST(req(msg('/scarica')));
    expect(mocks.listUploads).not.toHaveBeenCalled();
    const { text, options } = lastSend();
    expect(text).toContain('collega il tuo account');
    expect(options.replyMarkup).toEqual({ kind: 'mini' });
  });

  it('/scarica collegato senza upload: lo dice, non invia audio', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([]);
    await POST(req(msg('/scarica')));
    expect(mocks.listUploads).toHaveBeenCalledWith('user-1');
    expect(lastSend().text).toContain('Non hai ancora caricato');
    expect(mocks.sendAudio).not.toHaveBeenCalled();
  });

  it('/scarica collegato con upload: elenca i brani numerati, non invia audio', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([
      { id: 'a', title: 'Primo' },
      { id: 'b', title: 'Secondo' },
    ]);
    await POST(req(msg('/scarica')));
    const { text } = lastSend();
    expect(text).toContain('1. Primo');
    expect(text).toContain('2. Secondo');
    expect(mocks.sendAudio).not.toHaveBeenCalled();
    expect(mocks.getUpload).not.toHaveBeenCalled();
  });

  it('/scarica <n>: invia il brano scelto come audio (proprietario verificato lato server)', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([
      { id: 'a', title: 'Primo' },
      { id: 'b', title: 'Secondo' },
    ]);
    mocks.getUpload.mockResolvedValue({
      blobUrl: 'https://blob.example/secondo.mp3',
      title: 'Secondo',
      mimeType: 'audio/mpeg',
    });
    await POST(req(msg('/scarica 2')));
    expect(mocks.getUpload).toHaveBeenCalledWith('user-1', 'b');
    expect(mocks.sendAudio).toHaveBeenCalled();
    const audioCall = mocks.sendAudio.mock.calls[0];
    expect(audioCall?.[0]).toBe('123');
    expect(audioCall?.[1]).toBe('https://blob.example/secondo.mp3');
  });

  it('/scarica <n> fuori elenco: avvisa, non cerca il file', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([{ id: 'a', title: 'Primo' }]);
    await POST(req(msg('/scarica 9')));
    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(lastSend().text).toContain('fuori elenco');
    expect(mocks.sendAudio).not.toHaveBeenCalled();
  });

  it('/scarica in un gruppo: rifiuta e NON mostra né invia nulla di privato', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([{ id: 'a', title: 'Primo' }]);
    await POST(req(groupMsg('/scarica')));
    expect(mocks.listUploads).not.toHaveBeenCalled();
    expect(mocks.getUpload).not.toHaveBeenCalled();
    expect(mocks.sendAudio).not.toHaveBeenCalled();
    expect(lastSend().text).toContain('in privato');
  });

  it('/start <token> in un gruppo: NON collega l’account (niente upsert)', async () => {
    mocks.verify.mockReturnValue('user-9');
    await POST(req(groupMsg('/start tok123')));
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(lastSend().text).toContain('in privato');
  });

  it('/scarica <n> quando l’invio audio fallisce: ripiega sul link diretto', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([{ id: 'a', title: 'Primo' }]);
    mocks.getUpload.mockResolvedValue({
      blobUrl: 'https://blob.example/primo.mp3',
      title: 'Primo',
      mimeType: 'audio/mpeg',
    });
    mocks.sendAudio.mockResolvedValue(false);
    await POST(req(msg('/scarica 1')));
    expect(mocks.sendAudio).toHaveBeenCalled();
    const lastText = String(mocks.send.mock.calls.at(-1)?.[1] ?? '');
    expect(lastText).toContain('https://blob.example/primo.mp3');
  });
});
