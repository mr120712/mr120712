import { describe, expect, it } from 'vitest';
import {
  evaluateSolcoProPurchase,
  getSolcoProCheckoutMissingRequirements,
  isActiveSolcoProEntitlement,
  mapSolcoProBusinessAccountStatus,
  SOLCO_PRO_ACCESS_DURATION,
  SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT,
  SOLCO_PRO_PRICE_EURO_CENTS,
  type SolcoProCheckoutOrder,
  type SolcoProStripePaymentEvidence,
  type SolcoProStripeReadiness,
} from '@/lib/business/solco-pro-purchase-policy';

const readiness: SolcoProStripeReadiness = {
  configuration: 'ready',
  onboarding: 'complete',
  eurCheckoutSupported: true,
  eurVerificationSupported: true,
  bankPayoutVerified: true,
};
const order: SolcoProCheckoutOrder = {
  id: 'order-a',
  userId: 'user-a',
  stripeCheckoutSessionId: 'cs_test_solco_a',
  amountEuroCents: SOLCO_PRO_PRICE_EURO_CENTS,
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
const now = new Date('2027-01-31T12:00:00.000Z');

describe('policy di acquisto Solco Pro con Stripe', () => {
  it('mappa lo stato Business attestato come configurazione e onboarding completati', () => {
    const mapped = mapSolcoProBusinessAccountStatus(SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT, {
      eurCheckoutSupported: false,
      eurVerificationSupported: false,
      bankPayoutVerified: false,
    });

    expect(mapped).toMatchObject({
      configuration: 'ready',
      onboarding: 'complete',
      eurCheckoutSupported: false,
      eurVerificationSupported: false,
      bankPayoutVerified: false,
    });
    expect(getSolcoProCheckoutMissingRequirements(mapped)).toEqual([
      'stripe_eur_checkout',
      'stripe_eur_verification',
      'stripe_bank_payout',
    ]);
  });

  it('mantiene il prezzo EUR, il pagamento singolo e un mese di calendario', () => {
    const result = evaluateSolcoProPurchase({ userId: 'user-a', order, payment, now });

    expect(SOLCO_PRO_PRICE_EURO_CENTS).toBe(2400);
    expect(order).toMatchObject({ amountEuroCents: 2400, currency: 'EUR', paymentMode: 'payment' });
    expect(SOLCO_PRO_ACCESS_DURATION).toMatchObject({ kind: 'calendar_month', months: 1 });
    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.entitlement.validFrom).toEqual(now);
      expect(result.entitlement.validUntil.toISOString()).toBe('2027-02-28T12:00:00.000Z');
    }
  });

  it('tiene chiuso il checkout se configurazione, onboarding o supporto EUR mancano', () => {
    expect(
      getSolcoProCheckoutMissingRequirements({
        ...readiness,
        configuration: 'missing',
      }),
    ).toContain('stripe_configuration');
    expect(
      getSolcoProCheckoutMissingRequirements({
        ...readiness,
        onboarding: 'incomplete',
      }),
    ).toContain('stripe_onboarding');
    expect(
      getSolcoProCheckoutMissingRequirements({
        ...readiness,
        eurCheckoutSupported: false,
      }),
    ).toContain('stripe_eur_checkout');
    expect(
      getSolcoProCheckoutMissingRequirements({
        ...readiness,
        eurVerificationSupported: false,
      }),
    ).toContain('stripe_eur_verification');
    expect(
      getSolcoProCheckoutMissingRequirements({
        ...readiness,
        bankPayoutVerified: false,
      }),
    ).toContain('stripe_bank_payout');
    expect(getSolcoProCheckoutMissingRequirements(readiness)).toEqual([]);
  });

  it.each([
    ['redirect di successo', { redirect: 'success', sessionId: order.stripeCheckoutSessionId }],
    ['prova non verificata', { ...payment, verified: false }],
    ['pagamento non saldato', { ...payment, paymentStatus: 'unpaid' }],
  ])('non concede accesso per %s', (_label, candidate) => {
    expect(evaluateSolcoProPurchase({ userId: 'user-a', order, payment: candidate, now })).toEqual({
      confirmed: false,
      reason: 'payment_unconfirmed',
    });
  });

  it.each([
    ['sessione differente', { ...payment, sessionId: 'cs_other' }],
    ['importo differente', { ...payment, amountEuroCents: 2399 }],
    ['valuta USD', { ...payment, currency: 'USD' }],
    ['pagamento ricorrente', { ...payment, paymentMode: 'subscription' }],
    ['prodotto differente', { ...payment, productId: 'other-product' }],
  ])('rifiuta la verifica con %s', (_label, candidate) => {
    expect(evaluateSolcoProPurchase({ userId: 'user-a', order, payment: candidate, now })).toEqual({
      confirmed: false,
      reason: 'payment_mismatch',
    });
  });

  it('nega una sessione associata a un altro account o a un diverso riferimento ordine', () => {
    expect(evaluateSolcoProPurchase({ userId: 'user-b', order, payment, now })).toEqual({
      confirmed: false,
      reason: 'order_mismatch',
    });
    expect(
      evaluateSolcoProPurchase({
        userId: 'user-a',
        order,
        payment: { ...payment, clientReferenceId: 'order-other' },
        now,
      }),
    ).toEqual({ confirmed: false, reason: 'account_mismatch' });
  });

  it.each([
    ['importo', { ...order, amountEuroCents: 2401 }],
    ['valuta', { ...order, currency: 'USD' }],
    ['modalità ricorrente', { ...order, paymentMode: 'subscription' }],
    ['durata', { ...order, durationKey: 'two-months' }],
    ['sessione assente', { ...order, stripeCheckoutSessionId: null }],
  ])('nega un ordine con %s discordante', (_label, candidate) => {
    expect(evaluateSolcoProPurchase({ userId: 'user-a', order: candidate, payment, now })).toEqual({
      confirmed: false,
      reason: 'order_mismatch',
    });
  });

  it('nega accesso scaduto, futuro o appartenente a un altro account', () => {
    const result = evaluateSolcoProPurchase({ userId: 'user-a', order, payment, now });
    expect(result.confirmed).toBe(true);
    if (!result.confirmed) return;

    expect(isActiveSolcoProEntitlement(result.entitlement, 'user-a', now)).toBe(true);
    expect(isActiveSolcoProEntitlement(result.entitlement, 'user-b', now)).toBe(false);
    expect(isActiveSolcoProEntitlement(result.entitlement, 'user-a', result.entitlement.validUntil)).toBe(
      false,
    );
    expect(
      isActiveSolcoProEntitlement(
        { ...result.entitlement, validFrom: new Date('2027-02-01T12:00:00.000Z') },
        'user-a',
        now,
      ),
    ).toBe(false);
  });
});
