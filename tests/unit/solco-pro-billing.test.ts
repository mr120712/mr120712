// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  entitlementFindFirst: vi.fn(),
  createCustomerPortalSession: vi.fn(),
  getSubscriptionStatus: vi.fn(),
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
  verifyCheckoutSession: vi.fn(),
  createCustomerPortalSession: mocks.createCustomerPortalSession,
  getSubscriptionStatus: mocks.getSubscriptionStatus,
}));

import { GET as checkoutStatus } from '@/app/api/solco-pro/status/route';
import { POST as createPortal } from '@/app/api/solco-pro/subscription/portal/route';
import { POST as createCheckout } from '@/app/api/stripe-billing/checkout/route';
import {
  getSolcoProCheckoutStatusMessage,
  SOLCO_PRO_CHECKOUT_UNAVAILABLE_MESSAGE,
  SOLCO_PRO_OFFER_SUMMARY,
  SOLCO_PRO_PAYMENT_METHOD,
  SOLCO_PRO_PRICE,
} from '@/lib/business/solco-pro-billing';
import {
  type SolcoProCheckoutStatus,
  solcoProCheckoutStatusSchema,
} from '@/lib/contracts/solco-pro';

const account = { id: 'user-1', email: 'listener@example.test' };

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
  mocks.entitlementFindFirst.mockResolvedValue(null);
});

describe('billing Solco Pro una tantum', () => {
  it('mantiene 24,00 EUR, Stripe, una volta e un mese e richiede conferma dell’accredito bancario', () => {
    expect(SOLCO_PRO_PRICE).toBe('24,00 €');
    expect(SOLCO_PRO_OFFER_SUMMARY).toBe('24,00 EUR una tantum · 1 mese di accesso');
    expect(SOLCO_PRO_PAYMENT_METHOD).toBe('Stripe');
    expect(SOLCO_PRO_CHECKOUT_UNAVAILABLE_MESSAGE).toContain('un mese');
    expect(SOLCO_PRO_CHECKOUT_UNAVAILABLE_MESSAGE).toContain(
      'accredito sul conto bancario configurato',
    );
    expect(SOLCO_PRO_CHECKOUT_UNAVAILABLE_MESSAGE).toContain('chargesEnabled è true');
    expect(SOLCO_PRO_CHECKOUT_UNAVAILABLE_MESSAGE).toContain('accountStatus è complete');
  });

  it('mantiene il checkout EUR disabilitato anche per un account autenticato', async () => {
    const response = await createCheckout(
      request('/api/stripe-billing/checkout', 'POST', {
        userId: 'attacker-user',
        plan: 'premium',
        interval: 'month',
        amountEuroCents: 499,
        currency: 'USD',
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'solco_pro_eur_recurring_checkout_unavailable',
    });
  });

  it('ignora i parametri di ritorno del browser e mostra la readiness server-side', async () => {
    const response = await checkoutStatus(
      request('/api/solco-pro/status?session_id=cs_test_unverified'),
    );

    expect(response.status).toBe(200);
    expect(solcoProCheckoutStatusSchema.parse(await response.json())).toMatchObject({
      state: 'unavailable',
      reason: 'configuration_missing',
      missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
    });
  });

  it('mostra attivo e scadenza soltanto per un entitlement Stripe valido dell’account', async () => {
    mocks.entitlementFindFirst.mockResolvedValueOnce({
      userId: account.id,
      checkoutOrderId: 'order-1',
      stripeCheckoutSessionId: 'cs_test_paid',
      paymentMode: 'payment',
      amountEuroCents: 2400,
      currency: 'EUR',
      verificationState: 'confirmed',
      durationKey: 'one-calendar-month',
      durationKind: 'calendar_month',
      validFrom: new Date('2026-11-01T12:00:00.000Z'),
      validUntil: new Date('2026-12-01T12:00:00.000Z'),
    });

    const response = await checkoutStatus(request('/api/solco-pro/status'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'active',
      validUntil: '2026-12-01T12:00:00.000Z',
    });
  });

  it('nega stato anonimo e tratta gli errori di persistenza come non disponibili', async () => {
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const anonymous = await checkoutStatus(request('/api/solco-pro/status'));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.entitlementFindFirst).not.toHaveBeenCalled();

    mocks.entitlementFindFirst.mockRejectedValueOnce(new Error('database unavailable'));
    const unavailable = await checkoutStatus(request('/api/solco-pro/status'));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      state: 'unavailable',
      reason: 'verification_error',
      missing: [],
    });
  });

  it('non apre il portale subscription per l’offerta non ricorrente', async () => {
    const response = await createPortal(request('/api/solco-pro/subscription/portal', 'POST'));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'solco_pro_payment_management_unavailable',
    });
    expect(mocks.createCustomerPortalSession).not.toHaveBeenCalled();
  });

  it('applica same-origin e sessione alla rotta di checkout', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const crossOrigin = await createCheckout(request('/api/stripe-billing/checkout', 'POST', {}));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValue(true);
    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const anonymous = await createCheckout(request('/api/stripe-billing/checkout', 'POST', {}));
    expect(anonymous.status).toBe(401);
  });

  it('distingue readiness, pagamento non confermato e accesso attivo', () => {
    const unavailable: SolcoProCheckoutStatus = {
      state: 'unavailable',
      reason: 'configuration_missing',
      missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
    };
    const unconfirmed: SolcoProCheckoutStatus = {
      state: 'unconfirmed',
      reason: 'authoritative_confirmation_missing',
    };
    const active: SolcoProCheckoutStatus = {
      state: 'active',
      validUntil: '2026-12-08T12:00:00.000Z',
    };

    expect(solcoProCheckoutStatusSchema.safeParse(unavailable).success).toBe(true);
    expect(solcoProCheckoutStatusSchema.safeParse(unconfirmed).success).toBe(true);
    expect(solcoProCheckoutStatusSchema.safeParse(active).success).toBe(true);
    expect(solcoProCheckoutStatusSchema.safeParse({ state: 'active' }).success).toBe(false);
    expect(getSolcoProCheckoutStatusMessage(unavailable)).toContain('checkout EUR da 24,00 €');
    expect(getSolcoProCheckoutStatusMessage(unconfirmed)).toContain('server');
  });
});
