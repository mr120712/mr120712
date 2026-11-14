// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  getSession: vi.fn(),
  consume: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consume }));
vi.mock('@/lib/business/build-announcement.server', () => ({
  publishBotInviteNow: mocks.publish,
}));

import { POST } from '@/app/api/admin/telegram-bot-post/route';

function req() {
  return new Request('https://solco.test/api/admin/telegram-bot-post', { method: 'POST' });
}

const admin = { user: { id: 'u1', role: 'admin', emailVerified: true } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue(admin);
  mocks.consume.mockResolvedValue({ allowed: true });
  mocks.publish.mockResolvedValue({ posted: true, text: 'x', reason: 'ok' });
});

describe('POST /api/admin/telegram-bot-post', () => {
  it('403 se non same-origin, senza toccare sessione o invio', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('401 senza sessione', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('403 se non admin', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u1', role: 'user', emailVerified: true } });
    expect((await POST(req())).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('403 se admin senza email verificata', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u1', role: 'admin', emailVerified: false } });
    expect((await POST(req())).status).toBe(403);
  });

  it('429 oltre il limite, senza pubblicare', async () => {
    mocks.consume.mockResolvedValue({
      allowed: false,
      status: 429,
      error: 'rate_limited',
      message: 'slow',
      retryAfterSeconds: 30,
    });
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('admin + successo: 200 con esito', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ posted: true, reason: 'ok' });
    expect(mocks.publish).toHaveBeenCalled();
  });

  it('se la pubblicazione lancia: 500', async () => {
    mocks.publish.mockRejectedValue(new Error('boom'));
    expect((await POST(req())).status).toBe(500);
  });
});
