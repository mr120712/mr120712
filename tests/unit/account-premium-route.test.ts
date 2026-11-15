// @polsia:user-owned — GET /api/account/premium: Premium e fonte del proprio account (per il badge
// del profilo), con le stesse regole dell'ascolto; senza sessione 401, sessione non verificabile 503;
// risposta privata e mai in cache; la forma passa sempre dal contratto (Premium ⇔ fonte).
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  premiumAccessSource: vi.fn(),
}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/premium-access.server', () => ({
  premiumAccessSource: mocks.premiumAccessSource,
}));

import { GET } from '@/app/api/account/premium/route';
import { AccountPremiumResponseSchema } from '@/lib/contracts/account-premium';

const request = () => new Request('https://www.solcomusic.online/api/account/premium');

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.premiumAccessSource.mockReset();
});

describe('GET /api/account/premium', () => {
  it('account Premium: la fonte, mai in cache', async () => {
    mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
    mocks.premiumAccessSource.mockResolvedValue('unlimited');
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ premium: true, source: 'unlimited' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(mocks.premiumAccessSource).toHaveBeenCalledWith('user-1');
  });

  it('account Free: nessuna fonte', async () => {
    mocks.requireAuth.mockResolvedValue({ id: 'user-2' });
    mocks.premiumAccessSource.mockResolvedValue(null);
    const response = await GET(request());
    expect(await response.json()).toEqual({ premium: false, source: null });
  });

  it('senza sessione 401; sessione non verificabile 503; mai in cache', async () => {
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const unauthorized = await GET(request());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store');
    mocks.requireAuth.mockRejectedValue(new Error('db down'));
    expect((await GET(request())).status).toBe(503);
    expect(mocks.premiumAccessSource).not.toHaveBeenCalled();
  });
});

describe('contratto', () => {
  it('Premium sempre con una fonte, Free mai', () => {
    expect(
      AccountPremiumResponseSchema.safeParse({ premium: true, source: 'rewards' }).success,
    ).toBe(true);
    expect(AccountPremiumResponseSchema.safeParse({ premium: false, source: null }).success).toBe(
      true,
    );
    expect(AccountPremiumResponseSchema.safeParse({ premium: true, source: null }).success).toBe(
      false,
    );
    expect(
      AccountPremiumResponseSchema.safeParse({ premium: false, source: 'unlimited' }).success,
    ).toBe(false);
    expect(
      AccountPremiumResponseSchema.safeParse({ premium: true, source: 'stripe' }).success,
    ).toBe(false);
    expect(
      AccountPremiumResponseSchema.safeParse({ premium: true, source: 'inApp', email: 'x' })
        .success,
    ).toBe(false);
  });
});
