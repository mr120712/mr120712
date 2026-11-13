// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ diag: vi.fn() }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  telegramBotDiagnostics: mocks.diag,
}));

import { GET } from '@/app/api/telegram-check/route';

const SECRET = 'cron-secret-test';
const ORIGINAL = process.env.CRON_SECRET;

function req(bearer?: string) {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return new Request('https://solco.example/api/telegram-check', { headers });
}

const healthy = {
  configured: true,
  bot: { id: 1, username: 'solco_bot', name: 'Solco' },
  channel: { configured: true, id: '-100123', title: 'Solco', type: 'channel' },
  membership: { status: 'administrator', canPost: true },
  errors: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = SECRET;
  mocks.diag.mockResolvedValue(healthy);
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('GET /api/telegram-check', () => {
  it('404 senza Authorization o con secret sbagliato', async () => {
    expect((await GET(req())).status).toBe(404);
    expect((await GET(req('sbagliato'))).status).toBe(404);
    expect(mocks.diag).not.toHaveBeenCalled();
  });

  it('404 se CRON_SECRET non è configurato', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req(SECRET))).status).toBe(404);
  });

  it('200 healthy quando bot ok + admin che può postare', async () => {
    const res = await GET(req(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    expect(body.bot.username).toBe('solco_bot');
    expect(body.membership.canPost).toBe(true);
  });

  it('503 quando il bot non può postare nel canale', async () => {
    mocks.diag.mockResolvedValue({
      ...healthy,
      membership: { status: 'member', canPost: false },
    });
    const res = await GET(req(SECRET));
    expect(res.status).toBe(503);
    expect((await res.json()).healthy).toBe(false);
  });

  it('503 quando il token non è configurato (bot assente)', async () => {
    mocks.diag.mockResolvedValue({
      configured: false,
      channel: { configured: true },
      errors: ['TELEGRAM_BOT_TOKEN non impostato: il bot è disattivato.'],
    });
    const res = await GET(req(SECRET));
    expect(res.status).toBe(503);
    expect((await res.json()).healthy).toBe(false);
  });
});
