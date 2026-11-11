// @polsia:user-owned

export const SOLCO_PRO_PRICE_EURO_CENTS = 2400;
export const SOLCO_PRO_PRODUCT_ID = 'solco-pro';

export const SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT = {
  exists: true,
  chargesEnabled: true,
  accountStatus: 'complete',
} as const;

export type SolcoProStripeBusinessAccountStatus = {
  exists: boolean;
  chargesEnabled: boolean;
  accountStatus: 'complete' | 'incomplete' | 'unknown';
};

export type SolcoProAccessDuration = {
  key: 'one-calendar-month';
  kind: 'calendar_month';
  months: 1;
};

export const SOLCO_PRO_ACCESS_DURATION: SolcoProAccessDuration = {
  key: 'one-calendar-month',
  kind: 'calendar_month',
  months: 1,
};

export const SOLCO_PRO_CHECKOUT_MISSING_REQUIREMENTS = [
  'stripe_configuration',
  'stripe_onboarding',
  'stripe_eur_checkout',
  'stripe_eur_verification',
  'stripe_bank_payout',
] as const;

export type SolcoProCheckoutMissingRequirement =
  (typeof SOLCO_PRO_CHECKOUT_MISSING_REQUIREMENTS)[number];

export type SolcoProStripeReadiness = {
  configuration: 'ready' | 'missing' | 'unknown';
  onboarding: 'complete' | 'incomplete' | 'unknown';
  eurCheckoutSupported: boolean;
  eurVerificationSupported: boolean;
  bankPayoutVerified: boolean;
};

export function mapSolcoProBusinessAccountStatus(
  account: SolcoProStripeBusinessAccountStatus,
  capabilities: Pick<
    SolcoProStripeReadiness,
    'eurCheckoutSupported' | 'eurVerificationSupported' | 'bankPayoutVerified'
  >,
): SolcoProStripeReadiness {
  return {
    configuration: account.exists ? (account.chargesEnabled ? 'ready' : 'unknown') : 'missing',
    onboarding:
      account.accountStatus === 'complete'
        ? 'complete'
        : account.accountStatus === 'incomplete'
          ? 'incomplete'
          : 'unknown',
    ...capabilities,
  };
}

/** The installed Polsia module exposes USD-only checkout and verification. */
export const SOLCO_PRO_RUNTIME_READINESS: SolcoProStripeReadiness =
  mapSolcoProBusinessAccountStatus(SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT, {
    eurCheckoutSupported: false,
    eurVerificationSupported: false,
    bankPayoutVerified: false,
  });

export type SolcoProCheckoutOrder = {
  id: string;
  userId: string;
  stripeCheckoutSessionId: string | null;
  amountEuroCents: number;
  currency: string;
  paymentMode: string;
  productId: string;
  durationKey: string;
  durationKind: string;
};

/** Normalized evidence required from Polsia before an entitlement can be issued. */
export type SolcoProStripePaymentEvidence = {
  provider: 'polsia-stripe';
  verified: true;
  sessionId: string;
  paymentStatus: 'paid';
  paymentMode: 'payment';
  amountEuroCents: number;
  currency: 'EUR';
  productId: 'solco-pro';
  clientReferenceId: string;
};

export type SolcoProEntitlementRecord = {
  userId: string;
  checkoutOrderId: string;
  stripeCheckoutSessionId: string;
  amountEuroCents: number;
  currency: 'EUR';
  paymentMode: 'payment';
  verificationState: 'confirmed';
  durationKey: string;
  durationKind: 'calendar_month';
  validFrom: Date;
  validUntil: Date;
};

export type SolcoProPurchaseEvaluation =
  | {
      confirmed: false;
      reason:
        | 'checkout_unavailable'
        | 'payment_unconfirmed'
        | 'payment_mismatch'
        | 'account_mismatch'
        | 'order_mismatch';
    }
  | { confirmed: true; entitlement: SolcoProEntitlementRecord };

export function getSolcoProCheckoutMissingRequirements(
  readiness: SolcoProStripeReadiness = SOLCO_PRO_RUNTIME_READINESS,
): SolcoProCheckoutMissingRequirement[] {
  const missing: SolcoProCheckoutMissingRequirement[] = [];
  if (readiness.configuration !== 'ready') missing.push('stripe_configuration');
  if (readiness.onboarding !== 'complete') missing.push('stripe_onboarding');
  if (!readiness.eurCheckoutSupported) missing.push('stripe_eur_checkout');
  if (!readiness.eurVerificationSupported) missing.push('stripe_eur_verification');
  if (!readiness.bankPayoutVerified) missing.push('stripe_bank_payout');
  return missing;
}

export function getSolcoProCheckoutBlockReason(
  readiness: SolcoProStripeReadiness = SOLCO_PRO_RUNTIME_READINESS,
) {
  const missing = getSolcoProCheckoutMissingRequirements(readiness);
  return missing.length > 0 ? missing[0] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type VerifiedStripePaymentShape = {
  provider: 'polsia-stripe';
  verified: true;
  sessionId: string;
  paymentStatus: string;
  paymentMode: string;
  amountEuroCents: number;
  currency: string;
  productId: string;
  clientReferenceId: string;
};

function isSolcoProStripePaymentEvidence(value: unknown): value is VerifiedStripePaymentShape {
  if (!isRecord(value)) return false;
  return (
    value.provider === 'polsia-stripe' &&
    value.verified === true &&
    typeof value.sessionId === 'string' &&
    value.sessionId.trim().length > 0 &&
    typeof value.paymentStatus === 'string' &&
    typeof value.paymentMode === 'string' &&
    typeof value.amountEuroCents === 'number' &&
    typeof value.currency === 'string' &&
    typeof value.productId === 'string' &&
    typeof value.clientReferenceId === 'string' &&
    value.clientReferenceId.trim().length > 0
  );
}

function addCalendarMonth(start: Date): Date | null {
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return Number.isFinite(end.getTime()) ? end : null;
}

function isSolcoProEntitlementRecord(value: unknown): value is SolcoProEntitlementRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.userId === 'string' &&
    typeof value.checkoutOrderId === 'string' &&
    typeof value.stripeCheckoutSessionId === 'string' &&
    typeof value.amountEuroCents === 'number' &&
    value.currency === 'EUR' &&
    value.paymentMode === 'payment' &&
    value.verificationState === 'confirmed' &&
    typeof value.durationKey === 'string' &&
    value.durationKind === 'calendar_month' &&
    value.validFrom instanceof Date &&
    value.validUntil instanceof Date
  );
}

/** Browser redirects and client claims are not payment evidence. */
export function evaluateSolcoProPurchase(input: {
  userId: string;
  order: SolcoProCheckoutOrder;
  payment: unknown;
  now?: Date;
}): SolcoProPurchaseEvaluation {
  const { order } = input;
  if (
    !order.id.trim() ||
    !order.userId.trim() ||
    order.userId !== input.userId ||
    !order.stripeCheckoutSessionId?.trim() ||
    order.amountEuroCents !== SOLCO_PRO_PRICE_EURO_CENTS ||
    order.currency !== 'EUR' ||
    order.paymentMode !== 'payment' ||
    order.productId !== SOLCO_PRO_PRODUCT_ID ||
    order.durationKey !== SOLCO_PRO_ACCESS_DURATION.key ||
    order.durationKind !== SOLCO_PRO_ACCESS_DURATION.kind
  ) {
    return { confirmed: false, reason: 'order_mismatch' };
  }

  if (!isSolcoProStripePaymentEvidence(input.payment)) {
    return { confirmed: false, reason: 'payment_unconfirmed' };
  }

  const payment = input.payment;
  if (payment.paymentStatus !== 'paid') {
    return { confirmed: false, reason: 'payment_unconfirmed' };
  }
  if (
    payment.sessionId !== order.stripeCheckoutSessionId ||
    payment.amountEuroCents !== SOLCO_PRO_PRICE_EURO_CENTS ||
    payment.currency !== 'EUR' ||
    payment.paymentMode !== 'payment' ||
    payment.productId !== SOLCO_PRO_PRODUCT_ID
  ) {
    return { confirmed: false, reason: 'payment_mismatch' };
  }
  if (payment.clientReferenceId !== order.id) {
    return { confirmed: false, reason: 'account_mismatch' };
  }

  const validFrom = input.now ? new Date(input.now) : new Date();
  const validUntil = addCalendarMonth(validFrom);
  if (!validUntil) return { confirmed: false, reason: 'payment_unconfirmed' };

  return {
    confirmed: true,
    entitlement: {
      userId: input.userId,
      checkoutOrderId: order.id,
      stripeCheckoutSessionId: payment.sessionId,
      amountEuroCents: SOLCO_PRO_PRICE_EURO_CENTS,
      currency: 'EUR',
      paymentMode: 'payment',
      verificationState: 'confirmed',
      durationKey: SOLCO_PRO_ACCESS_DURATION.key,
      durationKind: SOLCO_PRO_ACCESS_DURATION.kind,
      validFrom,
      validUntil,
    },
  };
}

export function isActiveSolcoProEntitlement(
  value: unknown,
  userId: string,
  now = new Date(),
): value is SolcoProEntitlementRecord {
  if (!isSolcoProEntitlementRecord(value)) return false;
  const record = value;
  if (
    record.userId !== userId ||
    record.amountEuroCents !== SOLCO_PRO_PRICE_EURO_CENTS ||
    record.currency !== 'EUR' ||
    record.paymentMode !== 'payment' ||
    !record.checkoutOrderId.trim() ||
    !record.stripeCheckoutSessionId.trim() ||
    record.durationKey !== SOLCO_PRO_ACCESS_DURATION.key ||
    record.durationKind !== SOLCO_PRO_ACCESS_DURATION.kind ||
    !Number.isFinite(record.validFrom.getTime()) ||
    !Number.isFinite(record.validUntil.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    record.validFrom.getTime() > now.getTime()
  ) {
    return false;
  }
  const expectedEnd = addCalendarMonth(record.validFrom);
  return (
    expectedEnd !== null &&
    record.validUntil.getTime() === expectedEnd.getTime() &&
    record.validUntil.getTime() > now.getTime()
  );
}
