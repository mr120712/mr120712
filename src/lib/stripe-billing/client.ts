// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/stripe-billing@0.9.0. Drift = commit rejected.
//
// Server-only Polsia billing helpers. No Stripe SDK, no Stripe secrets in the
// app — checkout, customer portal, verify, and payment events go through the proxy.
// Full usage guide in AGENT.md.

import 'server-only';
import { env } from '@/lib/env';
import {
  type CheckoutItem,
  type CheckoutSessionResult,
  type CheckoutVerificationResult,
  type CreateCheckoutSessionInput,
  type CreateCustomerPortalSessionInput,
  type CustomerPortalSessionResult,
  checkoutSessionResultSchema,
  checkoutVerificationResultSchema,
  createCheckoutSessionInputSchema,
  createCustomerPortalSessionInputSchema,
  customerPortalSessionResultSchema,
  type PaymentEventsResult,
  type PaymentEventType,
  paymentEventsResultSchema,
  type SubscriptionStatusResult,
  subscriptionStatusResultSchema,
} from '@/lib/stripe-billing/schema';

export class StripeBillingConfigurationError extends Error {
  constructor(message = 'Stripe billing is not configured for this app.') {
    super(message);
    this.name = 'StripeBillingConfigurationError';
  }
}

// Runtime payments not enabled for this company. Surface this — NEVER fall back
// to a raw Stripe SDK integration or a hardcoded Stripe URL.
export class StripeBillingNotEnabledError extends Error {
  constructor(
    message = 'Runtime payments are not enabled for this app yet. Ask the owner to finish Stripe onboarding on the Polsia dashboard Payments page, or contact Polsia support.',
  ) {
    super(message);
    this.name = 'StripeBillingNotEnabledError';
  }
}

// Owner hasn't finished Stripe onboarding. Surface to the owner — not an app bug.
export class StripeBillingOnboardingError extends Error {
  readonly code: 'stripe_not_configured' | 'stripe_not_onboarded';

  constructor(code: 'stripe_not_configured' | 'stripe_not_onboarded') {
    super(
      code === 'stripe_not_configured'
        ? 'Stripe is not set up for this business yet. The owner must connect Stripe from the Polsia dashboard Payments page.'
        : 'Stripe onboarding is incomplete for this business. The owner must finish onboarding from the Polsia dashboard Payments page before payments can be accepted.',
    );
    this.name = 'StripeBillingOnboardingError';
    this.code = code;
  }
}

/** The backend did not confirm the requested product/customer scope. Do not retry by email. */
export class StripeBillingProductIdentityUnavailableError extends Error {
  constructor() {
    super(
      'The platform could not confirm the requested payment identity. Do not broaden the request or redirect to checkout.',
    );
    this.name = 'StripeBillingProductIdentityUnavailableError';
  }
}

export interface VerifyCheckoutSessionInput {
  sessionId: string;
}

export interface GetSubscriptionStatusInput {
  email?: string;
  /** A company-scoped customer id saved against the caller's verified purchase. */
  stripeCustomerId?: string;
  /** Restricts access to this product. Both buyer selectors, when given, intersect. */
  productKey?: string;
}

export interface ListPaymentEventsInput {
  /** Return events with id > sinceCursor. Persist nextCursor between calls. */
  sinceCursor?: number;
  /** 1..100, default 50. */
  limit?: number;
  /** Event types to return; omitted → the platform default (`payment_received` only). */
  types?: readonly PaymentEventType[];
}

/** Separator of the `types` query param expected by the events endpoint. */
const EVENT_TYPES_SEPARATOR = ',';

function polsiaApiBaseUrl() {
  return env.POLSIA_API_BASE_URL.replace(/\/+$/, '');
}

function polsiaApiKey() {
  const key = env.POLSIA_API_KEY ?? env.POLSIA_API_TOKEN;
  if (!key) {
    throw new StripeBillingConfigurationError(
      'POLSIA_API_KEY is missing. Polsia injects it into deployed apps; local dev must set it manually.',
    );
  }
  return key;
}

function buildUrl(path: string, searchParams: Record<string, string> = {}) {
  const base = polsiaApiBaseUrl();
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function throwTypedError(status: number, body: unknown): never {
  const detail =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : '';
  if (status === 404 && detail === 'not_enabled') {
    throw new StripeBillingNotEnabledError();
  }
  if (status === 409 && (detail === 'stripe_not_configured' || detail === 'stripe_not_onboarded')) {
    throw new StripeBillingOnboardingError(detail);
  }
  if (detail === 'product_identity_unavailable') {
    throw new StripeBillingProductIdentityUnavailableError();
  }
  throw new Error(`Polsia billing API request failed: ${status} ${detail}`.trim());
}

async function polsiaJson(
  path: string,
  init: { method: 'GET' | 'POST'; searchParams?: Record<string, string>; body?: unknown },
) {
  const res = await fetch(buildUrl(path, init.searchParams ?? {}), {
    method: init.method,
    headers: {
      authorization: `Bearer ${polsiaApiKey()}`,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throwTypedError(res.status, body);
  }
  return body;
}

export async function verifyCheckoutSession(
  input: VerifyCheckoutSessionInput,
): Promise<CheckoutVerificationResult> {
  const body = await polsiaJson('/api/company-payments/verify', {
    method: 'GET',
    searchParams: { session_id: input.sessionId },
  });
  return checkoutVerificationResultSchema.parse(body);
}

/**
 * Subscription access verdict + state for a customer, optionally scoped to a product. The platform
 * response is validated and returned AS-IS: `active` is the platform's access
 * verdict (true for `active` and `trialing` only) and `status` is Stripe's
 * subscription status passed through verbatim (`trialing`, `past_due`,
 * `unpaid`, `canceled`, `paused`, ... or `not_found`) — never remapped here.
 * Gate on `active`; render the subscriber's state from `status`. `plan`,
 * `monthly_amount`, `current_period_end` and `customer_email` are only present
 * while `active` is true. A scoped call (`stripeCustomerId` and/or `productKey`;
 * with `email` they intersect) throws StripeBillingProductIdentityUnavailableError
 * when the platform cannot answer it — never retry with fewer selectors.
 */
export async function getSubscriptionStatus(
  input: GetSubscriptionStatusInput,
): Promise<SubscriptionStatusResult> {
  const { email, stripeCustomerId, productKey } = input;
  // null counts as absent: 0.8.0 ignored every key but `email`.
  const scoped = stripeCustomerId != null || productKey != null;
  const body = await polsiaJson('/api/company-payments/subscription-status', {
    method: 'GET',
    searchParams: {
      // A missing email gets the platform's inactive answer, never a client error.
      ...(typeof email === 'string' ? { email } : {}),
      ...(stripeCustomerId != null ? { stripe_customer_id: stripeCustomerId } : {}),
      ...(productKey != null ? { product_key: productKey } : {}),
    },
  });
  const result = subscriptionStatusResultSchema.parse(body);
  // A scoped verdict must come from the identity read. Without it the platform refuses in
  // the body or omits `subscriptions` (an older one answers for the whole email).
  if (
    scoped &&
    (result.error !== undefined ||
      result.subscriptions === undefined ||
      (productKey != null && result.product_key !== productKey))
  ) {
    throw new StripeBillingProductIdentityUnavailableError();
  }
  return result;
}

/**
 * Runtime Stripe Checkout session → hosted checkout URL. Handles both:
 *   - one-time: a dynamic amount (`amountUsd`) or a cart (`lineItems`);
 *   - subscription: pass `recurring: { interval: 'month' | 'year' }` with
 *     `amountUsd` (the per-period price), with the applicable platform fee.
 * Prices MUST be computed server-side — never trust an amount from the browser.
 * Put `?session_id={CHECKOUT_SESSION_ID}` in successUrl so the success page can
 * call verifyCheckoutSession. For subscription access control later, poll
 * getSubscriptionStatus with the verified buyer identity and, optionally, productKey.
 * Sending productKey opts into strict identity capture: a missing/disabled echo
 * throws BEFORE returning a redirect URL. Calls without keys keep the legacy contract.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const parsed = createCheckoutSessionInputSchema.parse(input);
  const body = await polsiaJson('/api/v2/app-payments/checkout-session', {
    method: 'POST',
    body: {
      ...(parsed.lineItems
        ? {
            line_items: parsed.lineItems.map((item) => ({
              name: item.name,
              amount: item.amountUsd,
              ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
              ...(item.productKey !== undefined ? { product_key: item.productKey } : {}),
            })),
          }
        : { amount: parsed.amountUsd }),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.productKey !== undefined ? { product_key: parsed.productKey } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      success_url: parsed.successUrl,
      cancel_url: parsed.cancelUrl,
      ...(parsed.customerEmail !== undefined ? { customer_email: parsed.customerEmail } : {}),
      ...(parsed.recurring !== undefined
        ? { recurring: { interval: parsed.recurring.interval } }
        : {}),
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      ...(parsed.collectShippingAddress !== undefined
        ? { collect_shipping_address: parsed.collectShippingAddress }
        : {}),
      ...(parsed.shippingCountries !== undefined
        ? { shipping_countries: parsed.shippingCountries }
        : {}),
      ...(parsed.allowPromotionCodes !== undefined
        ? { allow_promotion_codes: parsed.allowPromotionCodes }
        : {}),
      ...(parsed.clientReferenceId !== undefined
        ? { client_reference_id: parsed.clientReferenceId }
        : {}),
      ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
      ...(parsed.billingAddressCollection !== undefined
        ? { billing_address_collection: parsed.billingAddressCollection }
        : {}),
      ...(parsed.collectPhoneNumber !== undefined
        ? { collect_phone_number: parsed.collectPhoneNumber }
        : {}),
      ...(parsed.submitType !== undefined ? { submit_type: parsed.submitType } : {}),
      ...(parsed.trialPeriodDays !== undefined
        ? { trial_period_days: parsed.trialPeriodDays }
        : {}),
    },
  });
  const session = (body as { checkout_session?: unknown })?.checkout_session;
  const raw = session as {
    id: number;
    stripe_session_id: string;
    url: string;
    total_amount_usd: number;
    company_receives: number;
    platform_fee: number;
    billing_interval?: 'month' | 'year';
    recurring?: boolean;
    checkout_id?: string;
    product_identity?: string;
  };
  const result = checkoutSessionResultSchema.parse({
    id: raw.id,
    stripeSessionId: raw.stripe_session_id,
    url: raw.url,
    totalAmountUsd: raw.total_amount_usd,
    companyReceives: raw.company_receives,
    platformFee: raw.platform_fee,
    ...(raw.billing_interval !== undefined ? { billingInterval: raw.billing_interval } : {}),
    ...(raw.recurring !== undefined ? { recurring: raw.recurring } : {}),
    ...(raw.checkout_id !== undefined ? { checkoutId: raw.checkout_id } : {}),
    ...(raw.product_identity !== undefined ? { productIdentity: raw.product_identity } : {}),
  });
  const hasProductKeys =
    parsed.productKey !== undefined ||
    parsed.lineItems?.some((item) => item.productKey !== undefined);
  if (hasProductKeys) {
    const expectedCoverage = parsed.lineItems?.some((item) => item.productKey === undefined)
      ? 'partial'
      : 'full';
    if (!result.checkoutId || result.productIdentity !== expectedCoverage) {
      throw new StripeBillingProductIdentityUnavailableError();
    }
  }
  return result;
}

/**
 * Creates a short-lived Stripe-hosted portal session for an authenticated
 * subscriber. Call this only from an app-owned server route protected by the
 * app's authentication or secure guest-access flow. Derive stripeCustomerId from
 * an owned, verified purchase (or customerEmail from the authenticated user), and
 * returnUrl from the app origin — never accept these identities from the browser.
 */
export async function createCustomerPortalSession(
  input: CreateCustomerPortalSessionInput,
): Promise<CustomerPortalSessionResult> {
  const parsed = createCustomerPortalSessionInputSchema.parse(input);
  const body = await polsiaJson('/api/v2/app-payments/customer-portal-session', {
    method: 'POST',
    body: {
      ...(parsed.customerEmail !== undefined ? { customer_email: parsed.customerEmail } : {}),
      ...(parsed.stripeCustomerId !== undefined
        ? { stripe_customer_id: parsed.stripeCustomerId }
        : {}),
      return_url: parsed.returnUrl,
    },
  });
  return customerPortalSessionResultSchema.parse(body);
}

/**
 * Cursor feed of the company's payment events — how the app learns a payment
 * landed WITHOUT any inbound Stripe callback. Persist nextCursor, poll from it,
 * process each event idempotently (dedupe on id). Renewals carry an invoice id
 * in stripeCheckoutSessionId; join them by stripeSubscriptionId, not that field.
 * `grossAmountUsd` is what the buyer paid; legacy `amountUsd` remains the
 * seller's recorded proceeds after applicable fees. Pass
 * `types: ['payment_received', 'payment_refunded']` to also read refunds.
 */
export async function listPaymentEvents(
  input: ListPaymentEventsInput = {},
): Promise<PaymentEventsResult> {
  const body = await polsiaJson('/api/v2/app-payments/events', {
    method: 'GET',
    searchParams: {
      ...(input.sinceCursor !== undefined ? { since: String(input.sinceCursor) } : {}),
      ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
      ...(input.types?.length ? { types: input.types.join(EVENT_TYPES_SEPARATOR) } : {}),
    },
  });
  type RawShipping = {
    name: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
  const raw = body as {
    events: Array<{
      id: number;
      type: string;
      amount_usd: number | null;
      gross_amount_usd?: number | null;
      customer_email: string | null;
      description: string | null;
      stripe_payment_intent_id: string | null;
      stripe_checkout_session_id: string | null;
      shipping?: RawShipping;
      occurred_at: string;
      kind?: string | null;
      checkout_id?: string | null;
      stripe_customer_id?: string | null;
      stripe_subscription_id?: string | null;
      client_reference_id?: string | null;
      metadata?: Record<string, string> | null;
      items?: CheckoutItem[] | null;
    }>;
    next_cursor: number;
  };
  return paymentEventsResultSchema.parse({
    events: (raw.events ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      amountUsd: e.amount_usd,
      ...(e.gross_amount_usd !== undefined ? { grossAmountUsd: e.gross_amount_usd } : {}),
      customerEmail: e.customer_email,
      description: e.description,
      stripePaymentIntentId: e.stripe_payment_intent_id,
      stripeCheckoutSessionId: e.stripe_checkout_session_id,
      shipping: e.shipping
        ? {
            name: e.shipping.name,
            line1: e.shipping.line1,
            line2: e.shipping.line2,
            city: e.shipping.city,
            state: e.shipping.state,
            postalCode: e.shipping.postal_code,
            country: e.shipping.country,
          }
        : null,
      occurredAt: e.occurred_at,
      ...(e.kind !== undefined ? { kind: e.kind } : {}),
      ...(e.checkout_id !== undefined ? { checkoutId: e.checkout_id } : {}),
      ...(e.stripe_customer_id !== undefined ? { stripeCustomerId: e.stripe_customer_id } : {}),
      ...(e.stripe_subscription_id !== undefined
        ? { stripeSubscriptionId: e.stripe_subscription_id }
        : {}),
      ...(e.client_reference_id !== undefined ? { clientReferenceId: e.client_reference_id } : {}),
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
      ...(e.items !== undefined
        ? {
            items:
              e.items === null
                ? null
                : e.items.map((item) => ({
                    position: item.position,
                    productKey: item.product_key,
                    name: item.name,
                    quantity: item.quantity,
                    unitAmountMinor: item.unit_amount_minor,
                    currency: item.currency,
                    interval: item.interval,
                  })),
          }
        : {}),
    })),
    nextCursor: raw.next_cursor,
  });
}
