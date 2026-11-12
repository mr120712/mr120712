// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  verifyAndPersistIapPurchase: vi.fn(),
  evaluateRewards: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));
vi.mock('@/lib/business/iap/entitlement.server', () => ({
  verifyAndPersistIapPurchase: mocks.verifyAndPersistIapPurchase,
}));
vi.mock('@/lib/business/rewards.server', () => ({ evaluateRewards: mocks.evaluateRewards }));

import { POST } from '@/app/api/solco-pro/iap/verify/route';

const account = { id: 'user-1', email: 'u@solco.test' };

function post(body?: unknown) {
  return new Request('https://solco.example/api/solco-pro/iap/verify', {
    method: 'POST',
    headers: { origin: 'https://solco.example', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validBody = { platform: 'apple', productId: 'solco_premium_monthly', token: 'txn-1' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.requireAuth.mockResolvedValue(account);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.evaluateRewards.mockResolvedValue(undefined);
});

describe('POST /api/solco-pro/iap/verify', () => {
  it('rifiuta origin non valido (CSRF)', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await POST(post(validBody));
    expect(res.status).toBe(403);
    expect(mocks.verifyAndPersistIapPurchase).not.toHaveBeenCalled();
  });

  it('richiede autenticazione', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('unauthorized', { status: 401 }));
    const res = await POST(post(validBody));
    expect(res.status).toBe(401);
  });

  it('applica il rate limit', async () => {
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const res = await POST(post(validBody));
    expect(res.status).toBe(429);
    expect(mocks.verifyAndPersistIapPurchase).not.toHaveBeenCalled();
  });

  it('rifiuta un corpo non valido', async () => {
    const res = await POST(post({ platform: 'nintendo' }));
    expect(res.status).toBe(400);
  });

  it('conferma un acquisto valido e assegna le ricompense al primo pagamento', async () => {
    mocks.verifyAndPersistIapPurchase.mockResolvedValue({
      confirmed: true,
      active: true,
      validUntil: new Date('2026-07-01T00:00:00.000Z'),
      planId: 'premium',
      firstPaid: true,
    });
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      active: true,
      validUntil: '2026-07-01T00:00:00.000Z',
      planId: 'premium',
    });
    expect(mocks.evaluateRewards).toHaveBeenCalledWith('user-1');
  });

  it('non assegna ricompense se non è il primo pagamento', async () => {
    mocks.verifyAndPersistIapPurchase.mockResolvedValue({
      confirmed: true,
      active: true,
      validUntil: null,
      planId: 'premium',
      firstPaid: false,
    });
    await POST(post(validBody));
    expect(mocks.evaluateRewards).not.toHaveBeenCalled();
  });

  it('restituisce 200 ok:false per account_mismatch', async () => {
    mocks.verifyAndPersistIapPurchase.mockResolvedValue({
      confirmed: false,
      reason: 'account_mismatch',
    });
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: 'account_mismatch' });
  });

  it('restituisce 503 per store_error', async () => {
    mocks.verifyAndPersistIapPurchase.mockResolvedValue({
      confirmed: false,
      reason: 'store_error',
    });
    const res = await POST(post(validBody));
    expect(res.status).toBe(503);
  });
});
