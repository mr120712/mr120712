// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SOLCO_PRO_ACCESS_DURATION,
  type SolcoProCheckoutOrder,
  type SolcoProEntitlementRecord,
  type SolcoProStripePaymentEvidence,
  type SolcoProStripeReadiness,
} from '@/lib/business/solco-pro-purchase-policy';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  orderCreate: vi.fn(),
  orderUpdate: vi.fn(),
  orderFindUnique: vi.fn(),
  entitlementUpsert: vi.fn(),
  entitlementFindFirst: vi.fn(),
  verifyCheckoutSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/stripe-billing/client', () => ({
  verifyCheckoutSession: mocks.verifyCheckoutSession,
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoProCheckoutOrder: {
      create: mocks.orderCreate,
      update: mocks.orderUpdate,
      findUnique: mocks.orderFindUnique,
    },
    solcoProStripeEntitlement: {
      upsert: mocks.entitlementUpsert,
      findFirst: mocks.entitlementFindFirst,
    },
  },
}));

import {
  findActiveSolcoProEntitlement,
  getSolcoProReadiness,
  persistVerifiedSolcoProPurchase,
  requireSolcoPro,
  type SolcoProStripeCheckoutGateway,
  startSolcoProCheckout,
  verifySolcoProPurchase,
} from '@/lib/business/solco-pro-entitlement';

const account = { id: 'user-a', email: 'listener@example.test' };
const now = new Date('2027-01-31T12:00:00.000Z');
const readiness: SolcoProStripeReadiness = {
  configuration: 'ready',
  onboarding: 'complete',
  eurCheckoutSupported: true,
  eurVerificationSupported: true,
  bankPayoutVerified: true,
};
const order: SolcoProCheckoutOrder = {
  id: 'order-a',
  userId: account.id,
  stripeCheckoutSessionId: 'cs_test_solco_a',
  amountEuroCents: 2400,
  currency: 'EUR',
  paymentMode: 'payment',
  productId: 'solco-pro',
  durationKey: SOLCO_PRO_ACCESS_DURATION.key,
  durationKind: SOLCO_PRO_ACCESS_DURATION.kind,
};
const payment: SolcoProStripePaymentEvidence = {
  provider: 'polsia-stripe',
  verified: true,
  sessionId: order.stripeCheckoutSessionId ?? '',
  paymentStatus: 'paid',
  paymentMode: 'payment',
  amountEuroCents: 2400,
  currency: 'EUR',
  productId: 'solco-pro',
  clientReferenceId: order.id,
};
const entitlement: SolcoProEntitlementRecord = {
  userId: account.id,
  checkoutOrderId: order.id,
  stripeCheckoutSessionId: order.stripeCheckoutSessionId ?? '',
  amountEuroCents: 2400,
  currency: 'EUR',
  paymentMode: 'payment',
  verificationState: 'confirmed',
  durationKey: SOLCO_PRO_ACCESS_DURATION.key,
  durationKind: SOLCO_PRO_ACCESS_DURATION.kind,
  validFrom: now,
  validUntil: new Date('2027-02-28T12:00:00.000Z'),
};

const simulatedGateway: SolcoProStripeCheckoutGateway = {
  createCheckoutSession: vi.fn(async () => ({
    sessionId: order.stripeCheckoutSessionId ?? '',
    url: 'https://stripe.test/hosted-session',
  })),
  verifyCheckoutSession: vi.fn(async () => payment),
};

beforeEach(() => {
  vi.resetAllMocks();
  simulatedGateway.createCheckoutSession = vi.fn(async () => ({
    sessionId: order.stripeCheckoutSessionId ?? '',
    url: 'https://stripe.test/hosted-session',
  }));
  simulatedGateway.verifyCheckoutSession = vi.fn(async () => payment);
  mocks.requireAuth.mockResolvedValue(account);
  mocks.orderCreate.mockResolvedValue({ ...order, stripeCheckoutSessionId: null });
  mocks.orderUpdate.mockResolvedValue(order);
  mocks.orderFindUnique.mockResolvedValue(order);
  mocks.entitlementUpsert.mockResolvedValue(entitlement);
  mocks.entitlementFindFirst.mockResolvedValue(entitlement);
});

describe('checkout e persistenza Solco Pro', () => {
  it('dichiara completati account Business e onboarding ma mantiene i tre blocchi checkout', () => {
    expect(getSolcoProReadiness()).toEqual({
      state: 'unavailable',
      missing: ['stripe_eur_checkout', 'stripe_eur_verification', 'stripe_bank_payout'],
      businessAccount: { exists: true, chargesEnabled: true, accountStatus: 'complete' },
    });
  });

  it('mantiene il checkout chiuso senza il supporto EUR del modulo installato', async () => {
    const result = await startSolcoProCheckout({
      userId: account.id,
      customerEmail: account.email,
      origin: 'https://solco.example',
    });

    expect(result).toEqual({ created: false, reason: 'checkout_unavailable' });
    expect(mocks.orderCreate).not.toHaveBeenCalled();
    expect(simulatedGateway.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('crea il checkout simulato con prezzo EUR fisso, pagamento singolo e riferimento ordine/account', async () => {
    const result = await startSolcoProCheckout({
      userId: account.id,
      customerEmail: account.email,
      origin: 'https://solco.example',
      gateway: simulatedGateway,
      readiness,
    });

    expect(result).toEqual({
      created: true,
      url: 'https://stripe.test/hosted-session',
      sessionId: 'cs_test_solco_a',
    });
    expect(mocks.orderCreate).toHaveBeenCalledWith({
      data: {
        userId: account.id,
        amountEuroCents: 2400,
        currency: 'EUR',
        paymentMode: 'payment',
        productId: 'solco-pro',
        durationKey: 'one-calendar-month',
        durationKind: 'calendar_month',
      },
    });
    expect(simulatedGateway.createCheckoutSession).toHaveBeenCalledWith({
      amountEuroCents: 2400,
      currency: 'EUR',
      paymentMode: 'payment',
      productId: 'solco-pro',
      durationMonths: 1,
      clientReferenceId: 'order-a',
      customerEmail: account.email,
      successUrl: 'https://solco.example/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://solco.example/checkout/cancelled',
    });
    expect(mocks.orderUpdate).toHaveBeenCalledWith({
      where: { id: 'order-a' },
      data: { stripeCheckoutSessionId: 'cs_test_solco_a' },
    });
  });

  it('mappa setup mancante e onboarding incompleto senza creare un checkout alternativo', async () => {
    const disabledGateway: SolcoProStripeCheckoutGateway = {
      ...simulatedGateway,
      createCheckoutSession: vi.fn(async () => {
        throw Object.assign(new Error('not enabled'), { name: 'StripeBillingNotEnabledError' });
      }),
    };
    const onboardingGateway: SolcoProStripeCheckoutGateway = {
      ...simulatedGateway,
      createCheckoutSession: vi.fn(async () => {
        throw Object.assign(new Error('onboarding incomplete'), {
          name: 'StripeBillingOnboardingError',
        });
      }),
    };

    const disabled = await startSolcoProCheckout({
      userId: account.id,
      customerEmail: account.email,
      origin: 'https://solco.example',
      gateway: disabledGateway,
      readiness,
    });
    const onboarding = await startSolcoProCheckout({
      userId: account.id,
      customerEmail: account.email,
      origin: 'https://solco.example',
      gateway: onboardingGateway,
      readiness,
    });

    expect(disabled).toEqual({ created: false, reason: 'stripe_not_enabled' });
    expect(onboarding).toEqual({ created: false, reason: 'stripe_onboarding_incomplete' });
  });

  it('verifica la sessione solo dopo averla trovata sull’ordine dell’account autenticato', async () => {
    const result = await verifySolcoProPurchase({
      userId: account.id,
      sessionId: 'cs_test_solco_a',
      gateway: simulatedGateway,
      readiness,
      now,
    });
    expect(result.confirmed).toBe(true);
    expect(mocks.orderFindUnique).toHaveBeenCalledWith({
      where: { stripeCheckoutSessionId: 'cs_test_solco_a' },
    });
    expect(simulatedGateway.verifyCheckoutSession).toHaveBeenCalledWith({
      sessionId: 'cs_test_solco_a',
    });

    mocks.orderFindUnique.mockResolvedValueOnce({ ...order, userId: 'user-other' });
    const forgedAccount = await verifySolcoProPurchase({
      userId: account.id,
      sessionId: 'cs_test_solco_a',
      gateway: simulatedGateway,
      readiness,
      now,
    });
    expect(forgedAccount).toEqual({ confirmed: false, reason: 'account_mismatch' });
  });

  it('nega verifica indisponibile, sessione non confermata e pagamento con valuta discordante', async () => {
    const unavailable: SolcoProStripeCheckoutGateway = {
      ...simulatedGateway,
      verifyCheckoutSession: vi.fn(async () => {
        throw new Error('verification unavailable');
      }),
    };
    const falsePayment: SolcoProStripeCheckoutGateway = {
      ...simulatedGateway,
      verifyCheckoutSession: vi.fn(async () => ({ ...payment, verified: false })),
    };
    const wrongCurrency: SolcoProStripeCheckoutGateway = {
      ...simulatedGateway,
      verifyCheckoutSession: vi.fn(async () => ({ ...payment, currency: 'USD' })),
    };

    await expect(
      verifySolcoProPurchase({
        userId: account.id,
        sessionId: 'cs_test_solco_a',
        gateway: unavailable,
        readiness,
        now,
      }),
    ).resolves.toEqual({ confirmed: false, reason: 'payment_unconfirmed' });
    await expect(
      verifySolcoProPurchase({
        userId: account.id,
        sessionId: 'cs_test_solco_a',
        gateway: falsePayment,
        readiness,
        now,
      }),
    ).resolves.toEqual({ confirmed: false, reason: 'payment_unconfirmed' });
    await expect(
      verifySolcoProPurchase({
        userId: account.id,
        sessionId: 'cs_test_solco_a',
        gateway: wrongCurrency,
        readiness,
        now,
      }),
    ).resolves.toEqual({ confirmed: false, reason: 'payment_mismatch' });
  });

  it('registra una sessione confermata in modo idempotente e preserva la prima scadenza', async () => {
    const first = await persistVerifiedSolcoProPurchase({
      userId: account.id,
      sessionId: 'cs_test_solco_a',
      gateway: simulatedGateway,
      readiness,
      now,
    });
    const retry = await persistVerifiedSolcoProPurchase({
      userId: account.id,
      sessionId: 'cs_test_solco_a',
      gateway: simulatedGateway,
      readiness,
      now: new Date(now.getTime() + 60_000),
    });

    expect(first.confirmed).toBe(true);
    expect(retry.confirmed).toBe(true);
    if (retry.confirmed) expect(retry.entitlement.validUntil).toEqual(entitlement.validUntil);
    expect(mocks.entitlementUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.entitlementUpsert).toHaveBeenCalledWith({
      where: { stripeCheckoutSessionId: 'cs_test_solco_a' },
      update: {},
      create: {
        ...entitlement,
      },
    });
  });

  it('nega una sessione già persistita per un account diverso e gli errori di persistenza', async () => {
    mocks.entitlementUpsert.mockResolvedValueOnce({ ...entitlement, userId: 'user-other' });
    const conflict = await persistVerifiedSolcoProPurchase({
      userId: account.id,
      sessionId: 'cs_test_solco_a',
      gateway: simulatedGateway,
      readiness,
      now,
    });
    expect(conflict).toEqual({ confirmed: false, reason: 'account_mismatch' });

    mocks.entitlementUpsert.mockRejectedValueOnce(new Error('database unavailable'));
    const failedWrite = await persistVerifiedSolcoProPurchase({
      userId: account.id,
      sessionId: 'cs_test_solco_a',
      gateway: simulatedGateway,
      readiness,
      now,
    });
    expect(failedWrite).toEqual({ confirmed: false, reason: 'checkout_unavailable' });
  });
});

describe('accesso server-side Solco Pro', () => {
  it('calcola lo stato attivo dalla registrazione Stripe e filtra solo record EUR singoli', async () => {
    const result = await findActiveSolcoProEntitlement(account.id, now);
    expect(result).toEqual(entitlement);
    expect(mocks.entitlementFindFirst).toHaveBeenCalledWith({
      where: {
        userId: account.id,
        paymentMode: 'payment',
        verificationState: 'confirmed',
        amountEuroCents: 2400,
        currency: 'EUR',
        durationKey: 'one-calendar-month',
        durationKind: 'calendar_month',
        validFrom: { lte: now },
        validUntil: { gt: now },
      },
      orderBy: { validFrom: 'desc' },
    });
  });

  it('nega sessioni anonime, database non disponibile ed entitlement con altro account', async () => {
    mocks.entitlementFindFirst.mockResolvedValueOnce({ ...entitlement, userId: 'user-other' });
    expect(await findActiveSolcoProEntitlement(account.id, now)).toBeNull();

    mocks.requireAuth.mockRejectedValueOnce(
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    const anonymous = await requireSolcoPro(
      new Request('https://solco.test/api/music/tracks/501/stream'),
    );
    expect(anonymous.allowed).toBe(false);
    if (!anonymous.allowed) expect(anonymous.response.status).toBe(401);

    mocks.entitlementFindFirst.mockRejectedValueOnce(new Error('database unavailable'));
    const unavailable = await requireSolcoPro(
      new Request('https://solco.test/api/music/tracks/501/stream'),
    );
    expect(unavailable.allowed).toBe(false);
    if (!unavailable.allowed) expect(unavailable.response.status).toBe(503);
  });
});
