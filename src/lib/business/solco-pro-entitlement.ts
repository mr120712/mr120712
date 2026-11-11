// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  evaluateSolcoProPurchase,
  getSolcoProCheckoutMissingRequirements,
  isActiveSolcoProEntitlement,
  SOLCO_PRO_ACCESS_DURATION,
  SOLCO_PRO_PRICE_EURO_CENTS,
  SOLCO_PRO_PRODUCT_ID,
  SOLCO_PRO_RUNTIME_READINESS,
  SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT,
  type SolcoProCheckoutOrder,
  type SolcoProEntitlementRecord,
  type SolcoProStripeReadiness,
} from '@/lib/business/solco-pro-purchase-policy';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { verifyCheckoutSession } from '@/lib/stripe-billing/client';

type ProAccessResult =
  | { allowed: true; user: SessionUser; entitlement: SolcoProEntitlementRecord }
  | { allowed: false; response: Response };

export type SolcoProStripeCheckoutInput = {
  amountEuroCents: 2400;
  currency: 'EUR';
  paymentMode: 'payment';
  productId: 'solco-pro';
  durationMonths: 1;
  clientReferenceId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
};

export type SolcoProStripeCheckoutGateway = {
  createCheckoutSession(
    input: SolcoProStripeCheckoutInput,
  ): Promise<{ sessionId: string; url: string }>;
  verifyCheckoutSession(input: { sessionId: string }): Promise<unknown>;
};

export type CheckoutStartResult =
  | { created: true; url: string; sessionId: string }
  | {
      created: false;
      reason: 'checkout_unavailable' | 'stripe_not_enabled' | 'stripe_onboarding_incomplete';
    };

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', privateHeaders['Cache-Control']);
  headers.set('Pragma', privateHeaders.Pragma);
  const vary = headers.get('Vary');
  headers.set('Vary', vary ? `${vary}, Cookie` : privateHeaders.Vary);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function denied(error: string, status: number) {
  return privateResponse(NextResponse.json({ error }, { status }));
}

export function getSolcoProReadiness(
  readiness: SolcoProStripeReadiness = SOLCO_PRO_RUNTIME_READINESS,
) {
  const missing = getSolcoProCheckoutMissingRequirements(readiness);
  return missing.length === 0
    ? { state: 'ready' as const, businessAccount: SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT }
    : {
        state: 'unavailable' as const,
        missing,
        businessAccount: SOLCO_PRO_STRIPE_BUSINESS_ACCOUNT,
      };
}

/**
 * The current stripe-billing@0.8.0 API has no EUR checkout method. The explicit
 * gateway argument keeps the account, offer and checkout rules testable with a
 * simulated Polsia EUR capability; no USD checkout fallback is provided.
 */
export async function startSolcoProCheckout(input: {
  userId: string;
  customerEmail: string;
  origin: string;
  gateway?: SolcoProStripeCheckoutGateway | null;
  readiness?: SolcoProStripeReadiness;
}): Promise<CheckoutStartResult> {
  const readiness = input.readiness ?? SOLCO_PRO_RUNTIME_READINESS;
  if (getSolcoProCheckoutMissingRequirements(readiness).length > 0 || !input.gateway) {
    return { created: false, reason: 'checkout_unavailable' };
  }

  const order = await prisma.solcoProCheckoutOrder.create({
    data: {
      userId: input.userId,
      amountEuroCents: SOLCO_PRO_PRICE_EURO_CENTS,
      currency: 'EUR',
      paymentMode: 'payment',
      productId: SOLCO_PRO_PRODUCT_ID,
      durationKey: SOLCO_PRO_ACCESS_DURATION.key,
      durationKind: SOLCO_PRO_ACCESS_DURATION.kind,
    },
  });

  try {
    const session = await input.gateway.createCheckoutSession({
      amountEuroCents: SOLCO_PRO_PRICE_EURO_CENTS,
      currency: 'EUR',
      paymentMode: 'payment',
      productId: SOLCO_PRO_PRODUCT_ID,
      durationMonths: SOLCO_PRO_ACCESS_DURATION.months,
      clientReferenceId: order.id,
      customerEmail: input.customerEmail,
      successUrl: `${input.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${input.origin}/checkout/cancelled`,
    });
    await prisma.solcoProCheckoutOrder.update({
      where: { id: order.id },
      data: { stripeCheckoutSessionId: session.sessionId },
    });
    return { created: true, url: session.url, sessionId: session.sessionId };
  } catch (error) {
    if (error instanceof Error && error.name === 'StripeBillingNotEnabledError') {
      return { created: false, reason: 'stripe_not_enabled' };
    }
    if (error instanceof Error && error.name === 'StripeBillingOnboardingError') {
      return { created: false, reason: 'stripe_onboarding_incomplete' };
    }
    return { created: false, reason: 'checkout_unavailable' };
  }
}

export async function findActiveSolcoProEntitlement(userId: string, now = new Date()) {
  const record = await prisma.solcoProStripeEntitlement.findFirst({
    where: {
      userId,
      paymentMode: 'payment',
      verificationState: 'confirmed',
      amountEuroCents: SOLCO_PRO_PRICE_EURO_CENTS,
      currency: 'EUR',
      durationKey: SOLCO_PRO_ACCESS_DURATION.key,
      durationKind: SOLCO_PRO_ACCESS_DURATION.kind,
      validFrom: { lte: now },
      validUntil: { gt: now },
    },
    orderBy: { validFrom: 'desc' },
  });
  return isActiveSolcoProEntitlement(record, userId, now) ? record : null;
}

export async function verifySolcoProPurchase(input: {
  userId: string;
  sessionId: string;
  gateway?: SolcoProStripeCheckoutGateway | null;
  readiness?: SolcoProStripeReadiness;
  now?: Date;
}) {
  const readiness = input.readiness ?? SOLCO_PRO_RUNTIME_READINESS;
  if (getSolcoProCheckoutMissingRequirements(readiness).length > 0 || !input.gateway) {
    return { confirmed: false as const, reason: 'checkout_unavailable' as const };
  }

  const order = await prisma.solcoProCheckoutOrder.findUnique({
    where: { stripeCheckoutSessionId: input.sessionId },
  });
  if (!order || order.userId !== input.userId) {
    return { confirmed: false as const, reason: 'account_mismatch' as const };
  }

  let payment: unknown;
  try {
    payment = await input.gateway.verifyCheckoutSession({ sessionId: input.sessionId });
  } catch {
    return { confirmed: false as const, reason: 'payment_unconfirmed' as const };
  }

  const evaluation = evaluateSolcoProPurchase({
    userId: input.userId,
    order: order as SolcoProCheckoutOrder,
    payment,
    now: input.now,
  });
  return evaluation;
}

/** Persists only a complete server-side Polsia verification, once per session. */
export async function persistVerifiedSolcoProPurchase(input: {
  userId: string;
  sessionId: string;
  gateway?: SolcoProStripeCheckoutGateway | null;
  readiness?: SolcoProStripeReadiness;
  now?: Date;
}) {
  const evaluation = await verifySolcoProPurchase(input);
  if (!evaluation.confirmed) return evaluation;

  try {
    const row = await prisma.solcoProStripeEntitlement.upsert({
      where: { stripeCheckoutSessionId: evaluation.entitlement.stripeCheckoutSessionId },
      update: {},
      create: evaluation.entitlement,
    });
    const samePurchase =
      row.userId === evaluation.entitlement.userId &&
      row.checkoutOrderId === evaluation.entitlement.checkoutOrderId &&
      row.stripeCheckoutSessionId === evaluation.entitlement.stripeCheckoutSessionId &&
      row.paymentMode === 'payment' &&
      row.amountEuroCents === SOLCO_PRO_PRICE_EURO_CENTS &&
      row.currency === 'EUR' &&
      row.durationKey === SOLCO_PRO_ACCESS_DURATION.key &&
      row.durationKind === SOLCO_PRO_ACCESS_DURATION.kind &&
      isActiveSolcoProEntitlement(row, input.userId, row.validFrom);
    return samePurchase
      ? { confirmed: true as const, entitlement: row }
      : { confirmed: false as const, reason: 'account_mismatch' as const };
  } catch {
    return { confirmed: false as const, reason: 'checkout_unavailable' as const };
  }
}

export async function requireSolcoPro(request: Request): Promise<ProAccessResult> {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return { allowed: false, response: privateResponse(response as Response) };
  }

  try {
    const entitlement = await findActiveSolcoProEntitlement(user.id);
    if (entitlement) return { allowed: true, user, entitlement };
    return { allowed: false, response: denied('pro_required', 403) };
  } catch {
    return { allowed: false, response: denied('pro_entitlement_unavailable', 503) };
  }
}

/** Call the installed verifier without treating its USD-only payload as EUR proof. */
export async function verifyWithInstalledPolsiaModule(sessionId: string): Promise<unknown> {
  return verifyCheckoutSession({ sessionId });
}
