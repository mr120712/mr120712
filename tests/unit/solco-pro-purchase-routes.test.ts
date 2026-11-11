// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  getReadiness: vi.fn(),
  persistPurchase: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: vi.fn(async () => null),
  consumeRateLimit: vi.fn(async () => ({ allowed: true })),
  getRateLimitIdentity: (id: string | null) => (id ? `user:${id}` : null),
}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.example' }));
vi.mock('@/lib/business/solco-pro-entitlement', () => ({
  getSolcoProReadiness: mocks.getReadiness,
  persistVerifiedSolcoProPurchase: mocks.persistPurchase,
}));

import { GET as getReadiness } from '@/app/api/solco-pro/purchase/readiness/route';
import { POST as verifyPurchase } from '@/app/api/solco-pro/purchase/verify/route';
import { POST as checkout } from '@/app/api/stripe-billing/checkout/route';

const account = { id: 'session-user', email: 'listener@example.test' };

function request(path: string, body?: unknown, origin = 'https://solco.example') {
  return new Request(`https://solco.example${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getReadiness.mockReturnValue({
    state: 'unavailable',
    missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
    businessAccount: { exists: true, chargesEnabled: true, accountStatus: 'complete' },
  });
  mocks.persistPurchase.mockResolvedValue({ confirmed: false, reason: 'payment_unconfirmed' });
});

describe('route acquisto Solco Pro con Stripe', () => {
  it('riporta completati configurazione e onboarding e blocca EUR/accredito senza creare una sessione', async () => {
    const response = await getReadiness();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'unavailable',
      missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
      businessAccount: { exists: true, chargesEnabled: true, accountStatus: 'complete' },
    });
  });

  it('rifiuta origine esterna e sessioni anonime prima di avviare Stripe', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await checkout(request('/api/stripe-billing/checkout', {}))).status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();

    mocks.sameOrigin.mockReturnValue(true);
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'unauthorized' }, { status: 401 }));
    expect((await checkout(request('/api/stripe-billing/checkout', {}))).status).toBe(401);
  });

  it('rifiuta l’avvio del checkout EUR anche con prezzo o account alterati dal client', async () => {
    const response = await checkout(
      request('/api/stripe-billing/checkout', {
        userId: 'attacker-user',
        plan: 'premium',
        interval: 'month',
        amountEuroCents: 1,
        currency: 'EUR',
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'solco_pro_eur_recurring_checkout_unavailable',
    });
  });

  it('nega l’accesso su pagamento simulato non confermato e su identità inviata dal client', async () => {
    const forged = await verifyPurchase(
      request('/api/solco-pro/purchase/verify', {
        sessionId: 'cs_test_account_a',
        userId: 'attacker-user',
      }),
    );
    expect(forged.status).toBe(400);
    expect(mocks.persistPurchase).not.toHaveBeenCalled();

    const unconfirmed = await verifyPurchase(
      request('/api/solco-pro/purchase/verify', { sessionId: 'cs_test_account_a' }),
    );
    expect(unconfirmed.status).toBe(200);
    expect(await unconfirmed.json()).toEqual({
      state: 'unconfirmed',
      reason: 'authoritative_confirmation_missing',
    });
    expect(mocks.persistPurchase).toHaveBeenCalledWith({
      userId: account.id,
      sessionId: 'cs_test_account_a',
    });
  });

  it('restituisce attivo e scadenza solo dopo la persistenza confermata', async () => {
    mocks.persistPurchase.mockResolvedValue({
      confirmed: true,
      entitlement: { validUntil: new Date('2027-02-28T12:00:00.000Z') },
    });
    const response = await verifyPurchase(
      request('/api/solco-pro/purchase/verify', { sessionId: 'cs_test_account_a' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'active',
      validUntil: '2027-02-28T12:00:00.000Z',
    });
  });
});
