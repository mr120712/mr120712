// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  status: vi.fn(),
  set: vi.fn(),
  sameOrigin: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/telegram-bot.server', () => ({
  telegramMenuStatus: mocks.status,
  setTelegramMenuButton: mocks.set,
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));

import { GET, POST } from '@/app/api/admin/telegram-menu/route';

const admin = { user: { id: 'u1', role: 'admin', emailVerified: true } };
const status = {
  botConfigured: true,
  type: 'web_app',
  text: 'Apri Solco',
  url: 'https://solco.example',
  expectedUrl: 'https://solco.example',
  matches: true,
  lastError: null,
};

function req(method = 'GET') {
  return new Request('https://solco.example/api/admin/telegram-menu', {
    method,
    headers: method === 'POST' ? { origin: 'https://solco.example' } : undefined,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue(admin);
  mocks.status.mockResolvedValue(status);
  mocks.set.mockResolvedValue({ ok: true, message: 'ok' });
});

describe('GET /api/admin/telegram-menu', () => {
  it('401 senza sessione', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('403 se non admin / email non verificata', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u', role: 'user', emailVerified: true } });
    expect((await GET(req())).status).toBe(403);
  });

  it('200 con lo stato del pulsante per un admin', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).matches).toBe(true);
  });
});

describe('POST /api/admin/telegram-menu', () => {
  it('403 su origine diversa', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await POST(req('POST'))).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('imposta il pulsante e ritorna 200 + stato aggiornato', async () => {
    const res = await POST(req('POST'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status.matches).toBe(true);
    expect(mocks.set).toHaveBeenCalled();
  });

  it('502 quando setChatMenuButton fallisce', async () => {
    mocks.set.mockResolvedValue({ ok: false, message: 'errore' });
    const res = await POST(req('POST'));
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });
});
