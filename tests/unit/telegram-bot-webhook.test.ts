// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  env: { TELEGRAM_WEBHOOK_SECRET: 'sec' as string | undefined, TELEGRAM_BOT_TOKEN: 'tok' },
  configured: true,
  /** Interruttore della libreria pubblica (src/lib/features.ts): spenta come in produzione. */
  publicUploads: false,
  send: vi.fn(async (_chatId?: string, _text?: string, _options?: unknown) => true),
  ensureCode: vi.fn(async (_userId?: string) => 'ABC123'),
  consume: vi.fn(),
  readJson: vi.fn(),
  deleteMany: vi.fn(async () => ({})),
  upsert: vi.fn(async () => ({})),
  findUnique: vi.fn(),
  findUser: vi.fn(),
  enforceRateLimit: vi.fn(),
  botSearch: vi.fn(async (_query?: string) => [] as unknown[]),
  sendAudio: vi.fn(async (_chatId?: string, _url?: string, _opts?: unknown) => true),
  listUploads: vi.fn(async (_userId?: string) => [] as Array<{ id: string; title: string }>),
  getUpload: vi.fn(
    async (_userId?: string, _id?: string) =>
      null as { blobUrl: string; title: string; mimeType: string } | null,
  ),
  answerCallback: vi.fn(async (_id?: string) => undefined),
  askSkynet: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => mocks.publicUploads }));
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
vi.mock('@/lib/skynet/chat.server', () => ({ askSkynet: mocks.askSkynet }));
vi.mock('@/lib/business/telegram-link', () => ({ consumeTelegramLinkChallenge: mocks.consume }));
vi.mock('@/lib/business/request-body.server', () => ({ readJsonLimited: mocks.readJson }));
vi.mock('@/lib/db', () => ({
  prisma: {
    telegramAccountLink: {
      deleteMany: mocks.deleteMany,
      upsert: mocks.upsert,
      findUnique: mocks.findUnique,
    },
    user: { findUnique: mocks.findUser },
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
  mocks.publicUploads = false;
  mocks.send.mockResolvedValue(true);
  mocks.ensureCode.mockResolvedValue('ABC123');
  mocks.findUnique.mockResolvedValue(null);
  mocks.findUser.mockResolvedValue(null);
  mocks.consume.mockResolvedValue(null);
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
    expect(text).toContain('collegare il tuo account');
    expect(options.replyMarkup).toEqual({ kind: 'mini' });
  });

  it('/help: messaggio di aiuto in HTML', async () => {
    await POST(req(msg('/help')));
    const { text, options } = lastSend();
    expect(text).toContain('Ecco cosa posso fare');
    expect(options.parseMode).toBe('HTML');
  });

  it('/start <token> valido: collega l’account e manda il codice', async () => {
    mocks.consume.mockResolvedValue('user-9');
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
    expect(text).toContain('collegare il tuo account');
    expect(options.replyMarkup).toEqual({ kind: 'mini' });
  });

  it('/scarica collegato senza upload (libreria pubblica attiva): invita a caricare da Pubblica', async () => {
    mocks.publicUploads = true;
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([]);
    await POST(req(msg('/scarica')));
    expect(mocks.listUploads).toHaveBeenCalledWith('user-1');
    expect(lastSend().text).toContain('Non hai ancora caricato');
    expect(lastSend().text).toContain('Pubblica');
    expect(mocks.sendAudio).not.toHaveBeenCalled();
  });

  it('/scarica collegato senza upload (libreria pubblica spenta): lo dice, senza invitare a caricare', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.listUploads.mockResolvedValue([]);
    await POST(req(msg('/scarica')));
    expect(mocks.listUploads).toHaveBeenCalledWith('user-1');
    const { text } = lastSend();
    expect(text).toContain('Non hai brani caricati su Solco');
    expect(text).not.toContain('Pubblica');
    expect(text).not.toMatch(/carical/i);
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
    mocks.consume.mockResolvedValue('user-9');
    await POST(req(groupMsg('/start tok123')));
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
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

describe('POST /api/telegram/webhook — /id e comando riservato /video', () => {
  afterEach(() => {
    delete process.env.SKYNET_TELEGRAM_CHAT_IDS;
    delete process.env.SKYNET_TELEGRAM_OWNER_USERNAMES;
    delete process.env.YTDLP_SERVICE_URL;
  });

  /** La chat 123 (username «u») è collegata, col codice monouso, a un amministratore verificato. */
  function linkedToAdmin() {
    mocks.findUnique.mockResolvedValue({ userId: 'admin-1' });
    mocks.findUser.mockResolvedValue({ role: 'admin', emailVerified: true });
  }

  it('gate sicuro: la chat collegata a un account amministratore è owner (/id lo conferma, /video parte)', async () => {
    linkedToAdmin();
    await POST(req(msg('/id')));
    expect(lastSend().text).toContain('riconosciuta come owner');

    mocks.send.mockClear();
    await POST(req(msg('/video https://youtu.be/abc')));
    const texts = mocks.send.mock.calls.map((call) => String(call[1]));
    expect(texts.some((text) => text.includes('YTDLP_SERVICE_URL'))).toBe(true);
  });

  it('gate sicuro: collegata a un utente NON amministratore → /video resta muto, /id non conferma', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'user-1' });
    mocks.findUser.mockResolvedValue({ role: 'user', emailVerified: true });
    await POST(req(msg('/video https://youtu.be/abc')));
    expect(mocks.send).not.toHaveBeenCalled();
    await POST(req(msg('/id')));
    expect(lastSend().text).not.toContain('owner');
    expect(lastSend().text).not.toContain('username');
  });

  it('secondo fattore username: admin collegato ma da un altro Telegram → muto, e /id spiega il motivo', async () => {
    linkedToAdmin();
    process.env.SKYNET_TELEGRAM_OWNER_USERNAMES = 'Solco_music';
    await POST(req(msg('/video https://youtu.be/abc')));
    expect(mocks.send).not.toHaveBeenCalled();
    await POST(req(msg('/id')));
    expect(lastSend().text).toContain('username Telegram non è fra quelli autorizzati');

    // Lo stesso admin, scrivendo dallo username autorizzato (maiuscole/minuscole non contano), passa.
    mocks.send.mockClear();
    await POST(
      req({
        message: {
          text: '/id',
          chat: { id: 123, type: 'private' },
          from: { username: 'solco_MUSIC' },
        },
      }),
    );
    expect(lastSend().text).toContain('riconosciuta come owner');
  });

  it('/id dice l’ID della chat a chiunque, senza accennare ai comandi riservati', async () => {
    await POST(req(msg('/id')));
    expect(lastSend().text).toContain('<code>123</code>');
    expect(lastSend().text).not.toContain('owner');
  });

  it('/id conferma l’owner solo nella sua chat privata (ID incollato con virgolette e spazi)', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = ' "123" ; 456';
    await POST(req(msg('/id')));
    expect(lastSend().text).toContain('riconosciuta come owner');

    mocks.send.mockClear();
    await POST(req(groupMsg('/id')));
    expect(lastSend().text).toContain('<code>123</code>');
    expect(lastSend().text).not.toContain('owner');
  });

  it('/video: silenzio totale per chi non è owner, anche in un gruppo dell’owner', async () => {
    const res = await POST(req(msg('/video https://youtu.be/abc')));
    expect(res.status).toBe(200);
    expect(mocks.send).not.toHaveBeenCalled();

    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    await POST(req(groupMsg('/video https://youtu.be/abc')));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('/video: per l’owner in privato parte (senza worker configurato lo dice)', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    await POST(req(msg('/video https://youtu.be/abc')));
    const texts = mocks.send.mock.calls.map((call) => String(call[1]));
    expect(texts.some((text) => text.includes('YTDLP_SERVICE_URL'))).toBe(true);
  });
});

describe('POST /api/telegram/webhook — /skynet, la chat della sentinella', () => {
  afterEach(() => {
    delete process.env.SKYNET_TELEGRAM_CHAT_IDS;
  });

  const texts = () => mocks.send.mock.calls.map((call) => String(call[1]));
  const answer = (extra: Record<string, unknown> = {}) => ({
    reply: 'Oggi tutto tranquillo.',
    engine: 'claude',
    sources: ['stato e segnali', 'diario', 'firewall di Vercel'],
    missing: [],
    ...extra,
  });

  beforeEach(() => {
    mocks.askSkynet.mockReset();
    mocks.askSkynet.mockResolvedValue(answer());
  });

  it('silenzio totale per chi non è owner, e anche per l’owner in un gruppo', async () => {
    const res = await POST(req(msg('/skynet cosa è successo oggi?')));
    expect(res.status).toBe(200);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.askSkynet).not.toHaveBeenCalled();

    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    await POST(req(groupMsg('/skynet cosa è successo oggi?')));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.askSkynet).not.toHaveBeenCalled();
    // Il limite della chat di Skynet non viene nemmeno toccato da un estraneo.
    expect(mocks.enforceRateLimit).not.toHaveBeenCalledWith('skynet.chat', expect.anything());
  });

  it('owner in privato: cerca, poi risponde con chi ha scritto e quante fonti ha letto', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    await POST(req(msg('/skynet Cosa è successo oggi?')));
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('skynet.chat', 'tg:123');
    expect(mocks.askSkynet).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'Cosa è successo oggi?' }],
      source: 'telegram',
      owner: true,
    });
    expect(texts()).toEqual([
      '🛰️ Cerco in tutte le fonti…',
      '<b>🛰️ Skynet</b>\nOggi tutto tranquillo.\n\n<i>Claude · 3 fonti lette</i>',
    ]);
    expect(mocks.send.mock.calls[1]?.[2]).toEqual({
      parseMode: 'HTML',
      disableWebPagePreview: true,
    });
  });

  it('la risposta arriva senza HTML attivo e dice le fonti che non ha potuto leggere', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    mocks.askSkynet.mockResolvedValue(
      answer({
        reply: 'Regola <b>spenta</b> & riaccesa',
        engine: 'reserve',
        sources: ['diario'],
        missing: ['firewall di Vercel', 'deploy'],
      }),
    );
    await POST(req(msg('/skynet@SolcoBot il firewall?')));
    expect(texts().at(-1)).toBe(
      '<b>🛰️ Skynet</b>\nRegola &lt;b&gt;spenta&lt;/b&gt; &amp; riaccesa\n\n<i>Riserva AI · 1 fonte letta · non lette: firewall di Vercel, deploy</i>',
    );
  });

  it('una risposta lunghissima resta sotto il limite di Telegram', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    mocks.askSkynet.mockResolvedValue(answer({ reply: 'x'.repeat(6000) }));
    await POST(req(msg('/skynet raccontami tutto')));
    const sent = texts().at(-1) ?? '';
    expect(sent.length).toBeLessThanOrEqual(3900);
    expect(sent.endsWith('…\n\n<i>Claude · 3 fonti lette</i>')).toBe(true);
  });

  it('/skynet senza domanda: spiega l’uso con gli esempi, non interpella il motore', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    await POST(req(msg('/skynet')));
    expect(mocks.askSkynet).not.toHaveBeenCalled();
    expect(lastSend().options.parseMode).toBe('HTML');
    expect(lastSend().text).toContain('<code>/skynet Cosa è successo oggi?</code>');
    expect(lastSend().text).toContain('<code>/skynet pausa autodifesa 2 ore</code>');
  });

  it('un comando parte subito, senza il messaggio di ricerca', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    mocks.askSkynet.mockResolvedValue(
      answer({ reply: 'Fatto: autodifesa in pausa.', engine: 'command', sources: [] }),
    );
    await POST(req(msg('/skynet pausa autodifesa 2 ore')));
    expect(mocks.askSkynet).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'pausa autodifesa 2 ore' }],
      source: 'telegram',
      owner: true,
    });
    expect(texts()).toEqual([
      '<b>🛰️ Skynet</b>\nFatto: autodifesa in pausa.\n\n<i>Comando eseguito senza AI</i>',
    ]);
  });

  it('domanda troppo lunga: tagliata prima di arrivare al motore', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    await POST(req(msg(`/skynet ${'a'.repeat(5000)}`)));
    const sentQuestion = mocks.askSkynet.mock.calls[0]?.[0].messages[0].content as string;
    expect(sentQuestion).toHaveLength(1000);
  });

  it('troppe domande: lo dice e non interpella il motore', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    mocks.enforceRateLimit.mockImplementation(async (action: string) =>
      action === 'skynet.chat' ? new Response(null, { status: 429 }) : null,
    );
    await POST(req(msg('/skynet ci sei?')));
    expect(texts()).toEqual(['Troppe domande di fila: riprovi tra poco.']);
    expect(mocks.askSkynet).not.toHaveBeenCalled();
  });

  it('se il motore fallisce lo dice, e Telegram riceve comunque 200', async () => {
    process.env.SKYNET_TELEGRAM_CHAT_IDS = '123';
    mocks.askSkynet.mockRejectedValue(new Error('database'));
    const res = await POST(req(msg('/skynet riprendi autodifesa')));
    expect(res.status).toBe(200);
    expect(texts()).toEqual([
      'Skynet non è riuscito a rispondere. Non è stato cambiato nulla: riprovi fra poco.',
    ]);
  });

  it('admin collegato col codice monouso: vale come owner anche per /skynet', async () => {
    mocks.findUnique.mockResolvedValue({ userId: 'admin-1' });
    mocks.findUser.mockResolvedValue({ role: 'admin', emailVerified: true });
    await POST(req(msg('/skynet tutto bene?')));
    expect(mocks.askSkynet).toHaveBeenCalledTimes(1);

    mocks.askSkynet.mockClear();
    mocks.send.mockClear();
    mocks.findUser.mockResolvedValue({ role: 'user', emailVerified: true });
    await POST(req(msg('/skynet tutto bene?')));
    expect(mocks.askSkynet).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
