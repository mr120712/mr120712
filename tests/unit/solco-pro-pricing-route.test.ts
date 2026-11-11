// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));

import { GET as getPlans } from '@/app/api/solco-pro/plans/route';

const account = { id: 'listener-1', email: 'listener@example.test' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
});

describe('endpoint autenticato dei prezzi Solco', () => {
  it('restituisce dal server prezzi in centesimi e stato non verificato con cache privata', async () => {
    const request = new Request('https://solco.test/api/solco-pro/plans');
    const response = await getPlans(request);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(mocks.requireAuth).toHaveBeenCalledWith(request);
    expect(result.plans.map((plan: { id: string }) => plan.id)).toEqual([
      'free',
      'premium',
      'premium-plus',
      'family',
    ]);
    expect(result.plans.map((plan: { monthlyEuroCents: number; annualEuroCents: number }) => [
      plan.monthlyEuroCents,
      plan.annualEuroCents,
    ])).toEqual([
      [0, 0],
      [499, 4999],
      [799, 7999],
      [1299, 12999],
    ]);
    expect(result).toMatchObject({
      planBenefitsMapped: false,
      stripePricesVerified: false,
      purchaseAvailable: false,
      billingChangesAvailable: false,
    });
  });

  it('nega la lettura anonima', async () => {
    mocks.requireAuth.mockRejectedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await getPlans(new Request('https://solco.test/api/solco-pro/plans'));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
