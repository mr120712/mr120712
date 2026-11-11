// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  entitlementFindFirst: vi.fn(),
  createCustomerPortalSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoProStripeEntitlement: { findFirst: mocks.entitlementFindFirst },
  },
}));
vi.mock('@/lib/stripe-billing/client', () => ({
  createCustomerPortalSession: mocks.createCustomerPortalSession,
}));

import { POST as createPortal } from '@/app/api/solco-pro/subscription/portal/route';
import { GET as getEntitlement } from '@/app/api/solco-pro/subscription/route';

const account = { id: 'listener-1', email: 'listener@example.test' };

function request(path: string, method = 'GET') {
  return new Request('https://solco.example' + path, {
    method,
    headers: method === 'POST' ? { origin: 'https://solco.example' } : undefined,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
  mocks.sameOrigin.mockReturnValue(true);
});

describe('stato accesso Solco Pro una tantum', () => {
  it('mostra l’accesso bloccato finché non esiste un entitlement verificato', async () => {
    const response = await getEntitlement(request('/api/solco-pro/subscription'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'locked', validUntil: null, purchase: null });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.entitlementFindFirst).toHaveBeenCalledWith({
      where: {
        userId: account.id,
        paymentMode: 'payment',
        verificationState: 'confirmed',
        amountEuroCents: 2400,
        currency: 'EUR',
        durationKey: 'one-calendar-month',
        durationKind: 'calendar_month',
        validFrom: { lte: expect.any(Date) },
        validUntil: { gt: expect.any(Date) },
      },
      orderBy: { validFrom: 'desc' },
    });
  });

  it('nega la lettura anonima', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await getEntitlement(request('/api/solco-pro/subscription'));
    expect(response.status).toBe(401);
    expect(mocks.entitlementFindFirst).not.toHaveBeenCalled();
  });

  it('mostra importo, durata senza rinnovo e termine solo per un acquisto precedente verificato', async () => {
    mocks.entitlementFindFirst.mockResolvedValueOnce({
      userId: account.id,
      checkoutOrderId: 'order-previous',
      stripeCheckoutSessionId: 'cs_previous_verified',
      paymentMode: 'payment',
      amountEuroCents: 2400,
      currency: 'EUR',
      verificationState: 'confirmed',
      durationKey: 'one-calendar-month',
      durationKind: 'calendar_month',
      validFrom: new Date('2026-11-01T12:00:00.000Z'),
      validUntil: new Date('2026-12-01T12:00:00.000Z'),
    });

    const response = await getEntitlement(request('/api/solco-pro/subscription'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'active',
      validUntil: '2026-12-01T12:00:00.000Z',
      purchase: {
        planId: 'solco-pro',
        paymentMode: 'payment',
        amountEuroCents: 2400,
        currency: 'EUR',
        validUntil: '2026-12-01T12:00:00.000Z',
        renewalAt: null,
      },
    });
  });

  it('rifiuta la gestione dei pagamenti e non crea un portale Stripe', async () => {
    const response = await createPortal(request('/api/solco-pro/subscription/portal', 'POST'));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'solco_pro_payment_management_unavailable',
    });
    expect(mocks.createCustomerPortalSession).not.toHaveBeenCalled();
  });

  it('non apre il portale per una sessione anonima', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await createPortal(request('/api/solco-pro/subscription/portal', 'POST'));

    expect(response.status).toBe(401);
    expect(mocks.createCustomerPortalSession).not.toHaveBeenCalled();
  });

  it('applica same-origin prima dell’autenticazione sui POST', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const response = await createPortal(request('/api/solco-pro/subscription/portal', 'POST'));
    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });
});
