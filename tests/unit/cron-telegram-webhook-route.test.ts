// @polsia:user-owned — unit della rotta ops /api/cron/telegram-webhook: auth con CRON_SECRET,
// auto-riparazione (ri-registra solo se non «ready»), ?force=1 che forza, e 502 quando setWebhook
// fallisce. telegram-bot.server è mockato: nessuna rete verso Telegram.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ register: vi.fn(), status: vi.fn() }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  registerTelegramWebhook: mocks.register,
  telegramWebhookStatus: mocks.status,
}));

import { GET } from '@/app/api/cron/telegram-webhook/route';

// cronAuthorized richiede un segreto di almeno 24 caratteri.
const SECRET = 'telegram-cron-secret-0123456789';
const ORIGINAL = process.env.CRON_SECRET;

function req(bearer?: string, query = '') {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request(`https://solco.example/api/cron/telegram-webhook${query}`, { headers });
}

const READY = {
  ready: true,
  botConfigured: true,
  secretConfigured: true,
  expectedUrl: 'https://www.solcomusic.online/api/telegram/webhook',
  currentUrl: 'https://www.solcomusic.online/api/telegram/webhook',
  matches: true,
  pendingUpdates: 0,
  lastError: null,
};
const NOT_READY = {
  ...READY,
  ready: false,
  currentUrl: null,
  matches: false,
  lastError: 'Wrong response from the webhook: 502',
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/cron/telegram-webhook', () => {
  it('401 senza Authorization o con secret sbagliato', async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('sbagliato'))).status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('401 se CRON_SECRET manca o è troppo corto', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req(SECRET))).status).toBe(401);
    process.env.CRON_SECRET = 'corto';
    expect((await GET(req('corto'))).status).toBe(401);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('auto-riparazione: se è già ready e non è forzato, NON ri-registra', async () => {
    mocks.status.mockResolvedValue(READY);
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe('skipped');
    expect(body.ok).toBe(true);
    expect(body.status.ready).toBe(true);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('ri-registra quando NON è ready', async () => {
    mocks.status.mockResolvedValueOnce(NOT_READY).mockResolvedValueOnce(READY);
    mocks.register.mockResolvedValue({ ok: true, message: 'Webhook registrato con successo.' });
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe('registered');
    expect(body.ok).toBe(true);
    expect(body.status.ready).toBe(true);
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it('?force=1 ri-registra anche se è già ready', async () => {
    mocks.status.mockResolvedValue(READY);
    mocks.register.mockResolvedValue({ ok: true, message: 'Webhook registrato con successo.' });
    const res = await GET(req(SECRET, '?force=1'));
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('registered');
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });

  it('502 quando setWebhook fallisce', async () => {
    mocks.status.mockResolvedValue(NOT_READY);
    mocks.register.mockResolvedValue({ ok: false, message: 'setWebhook non riuscito.' });
    const res = await GET(req(SECRET, '?force=1'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.action).toBe('failed');
    expect(body.ok).toBe(false);
    expect(body.message).toBe('setWebhook non riuscito.');
  });

  it('500 se la lettura dello stato lancia', async () => {
    mocks.status.mockRejectedValue(new Error('telegram down'));
    const res = await GET(req(SECRET));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('register_failed');
  });
});
