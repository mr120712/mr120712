// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  status: vi.fn(),
  register: vi.fn(),
  sameOrigin: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  telegramWebhookStatus: mocks.status,
  registerTelegramWebhook: mocks.register,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));

import { GET, POST } from '@/app/api/admin/telegram-webhook/route';

const admin = { user: { id: 'u1', role: 'admin', emailVerified: true } };
const status = {
  ready: true,
  botConfigured: true,
  secretConfigured: true,
  expectedUrl: 'https://solco.example/api/telegram/webhook',
  currentUrl: 'https://solco.example/api/telegram/webhook',
  matches: true,
  pendingUpdates: 0,
  lastError: null,
};

function req(method = 'GET') {
  return new Request('https://solco.example/api/admin/telegram-webhook', {
    method,
    headers: method === 'POST' ? { origin: 'https://solco.example' } : undefined,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue(admin);
  mocks.status.mockResolvedValue(status);
  mocks.register.mockResolvedValue({ ok: true, message: 'ok' });
});

describe('GET /api/admin/telegram-webhook', () => {
  it('401 senza sessione', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('403 se non admin / email non verificata', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u', role: 'user', emailVerified: true } });
    expect((await GET(req())).status).toBe(403);
  });

  it('200 con lo stato del webhook per un admin', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(true);
  });
});

describe('POST /api/admin/telegram-webhook', () => {
  it('403 su origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(req('POST'))).status).toBe(403);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('registra il webhook e ritorna 200 + stato aggiornato', async () => {
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status.ready).toBe(true);
    expect(mocks.register).toHaveBeenCalled();
  });

  it('502 quando setWebhook fallisce', async () => {
    mocks.register.mockResolvedValue({ ok: false, message: 'errore' });
    const res = await POST(req('POST'));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });
});
