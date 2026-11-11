// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  selectionFindUnique: vi.fn(),
  selectionUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoPlanSelection: {
      findUnique: mocks.selectionFindUnique,
      upsert: mocks.selectionUpsert,
    },
  },
}));

import { GET, POST } from '@/app/api/solco-pro/plan-selection/route';

const account = { id: 'listener-1', email: 'listener@example.test' };
const selectedAt = new Date('2026-11-09T12:00:00.000Z');

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`https://solco.example${path}`, {
    method,
    headers:
      method === 'POST'
        ? { origin: 'https://solco.example', 'content-type': 'application/json' }
        : undefined,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.selectionFindUnique.mockResolvedValue(null);
  mocks.selectionUpsert.mockImplementation(
    async ({ create }: { create: { billingPeriod: string } }) => ({
      planId: 'free',
      billingPeriod: create.billingPeriod,
      updatedAt: selectedAt,
    }),
  );
});

describe('scelta del piano Free Solco', () => {
  it.each(['month', 'year'] as const)(
    'salva Free a 0 EUR con cadenza %s per il solo account autenticato',
    async (billingPeriod) => {
      const response = await POST(
        request('/api/solco-pro/plan-selection', 'POST', { planId: 'free', billingPeriod }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        selection: {
          planId: 'free',
          billingPeriod,
          amountEuroCents: 0,
          currency: 'EUR',
          state: 'active',
          selectedAt: selectedAt.toISOString(),
          renewalAt: null,
        },
      });
      expect(mocks.selectionUpsert).toHaveBeenCalledWith({
        where: { userId: account.id },
        create: { userId: account.id, planId: 'free', billingPeriod },
        update: { billingPeriod },
        select: { planId: true, billingPeriod: true, updatedAt: true },
      });
      expect(response.headers.get('cache-control')).toContain('private, no-store');
    },
  );

  it('legge solo la selezione dell’account corrente senza cache condivisa', async () => {
    mocks.selectionFindUnique.mockResolvedValueOnce({
      planId: 'free',
      billingPeriod: 'year',
      updatedAt: selectedAt,
    });

    const response = await GET(request('/api/solco-pro/plan-selection'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      selection: { planId: 'free', billingPeriod: 'year', amountEuroCents: 0, renewalAt: null },
    });
    expect(mocks.selectionFindUnique).toHaveBeenCalledWith({
      where: { userId: account.id },
      select: { planId: true, billingPeriod: true, updatedAt: true },
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('rifiuta sessioni anonime, origine esterna e selezioni di piani a pagamento', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossOrigin = await POST(
      request('/api/solco-pro/plan-selection', 'POST', { planId: 'free', billingPeriod: 'month' }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();

    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const anonymous = await POST(
      request('/api/solco-pro/plan-selection', 'POST', { planId: 'free', billingPeriod: 'month' }),
    );
    expect(anonymous.status).toBe(401);
    expect(mocks.selectionUpsert).not.toHaveBeenCalled();

    const paid = await POST(
      request('/api/solco-pro/plan-selection', 'POST', {
        planId: 'premium',
        billingPeriod: 'month',
      }),
    );
    expect(paid.status).toBe(409);
    expect(await paid.json()).toEqual({
      error: 'solco_paid_plan_unavailable_until_eur_prices_are_verified',
    });
    expect(mocks.selectionUpsert).not.toHaveBeenCalled();

    const alteredPrice = await POST(
      request('/api/solco-pro/plan-selection', 'POST', {
        planId: 'free',
        billingPeriod: 'month',
        amountEuroCents: 1,
      }),
    );
    expect(alteredPrice.status).toBe(400);
    expect(mocks.selectionUpsert).not.toHaveBeenCalled();
  });

  it('non sovrascrive un piano diverso senza conferma del provider', async () => {
    mocks.selectionFindUnique.mockResolvedValueOnce({ planId: 'premium' });

    const response = await POST(
      request('/api/solco-pro/plan-selection', 'POST', { planId: 'free', billingPeriod: 'year' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'solco_contract_change_requires_provider_confirmation',
    });
    expect(mocks.selectionUpsert).not.toHaveBeenCalled();
  });
});
