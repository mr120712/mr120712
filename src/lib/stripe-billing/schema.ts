// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/stripe-billing@0.9.0. Drift = commit rejected.
//
// Shared billing schemas + types. Client-safe: no server-only imports, no secrets.

import { z } from 'zod';

export const checkoutSessionQuerySchema = z.object({
  session_id: z.string().min(1, 'session_id is required'),
});

export const verifiedPaymentSchema = z.object({
  /** Seller proceeds recorded by Polsia after applicable fees. */
  amount_usd: z.number(),
  /**
   * Buyer-paid Checkout total. Optional for platform responses predating this
   * field; null means the historical payment row has no usable gross evidence.
   */
  gross_amount_usd: z.number().nullable().optional(),
  customer_email: z.string().email().nullable().optional(),
  product_name: z.string().nullable().optional(),
  paid_at: z.string().nullable().optional(),
});

const productKeySchema = z.string().regex(/^[\x21-\x7E]{1,200}$/, 'invalid product key');
const stripeCustomerIdSchema = z
  .string()
  .max(255)
  .regex(/^cus_[A-Za-z0-9]+$/);
/**
 * Checkout identity coverage: 'full' | 'partial' | 'none' | 'disabled' today. Kept a string so a
 * future value never breaks an unkeyed checkout; keyed checkouts still require the exact match.
 */
const productIdentityCoverageSchema = z.string();

/**
 * Recorded checkout lines, in the platform's snake_case wire format. `interval` is
 * 'month' | 'year' | null and `mode` 'payment' | 'subscription' today; both stay strings
 * because these fields are on every response, so a future value must never break a read.
 */
export const checkoutItemSchema = z.object({
  position: z.number().int(),
  product_key: z.string().nullable(),
  name: z.string(),
  quantity: z.number().int(),
  unit_amount_minor: z.number().int(),
  currency: z.string(),
  interval: z.string().nullable(),
});

/** Server-only purchase context. Never forward this wholesale to a public route. */
export const checkoutOrderSchema = z.object({
  checkout_id: z.string(),
  mode: z.string(),
  client_reference_id: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  items: z.array(checkoutItemSchema),
});

export const checkoutVerificationResultSchema = z.object({
  verified: z.boolean(),
  payment: verifiedPaymentSchema.optional(),
  /** Absent on older backends; null for payments with no recorded checkout identity. */
  order: checkoutOrderSchema.nullable().optional(),
  error: z.string().optional(),
});

// -- Subscription status (access gate + subscription-state UX) ---------------

/**
 * Every `status` value `getSubscriptionStatus` can return. The platform passes
 * Stripe's `subscription.status` through VERBATIM (no remapping), plus
 * `not_found` when no subscription exists for that email. Access is the
 * platform's call: `active` is true only for `active` and `trialing`.
 */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'paused',
  'not_found',
] as const;

export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export const subscriptionEntrySchema = z.object({
  stripe_subscription_id: z.string().nullable(),
  status: z.string(),
  active: z.boolean(),
  plan: z.string(),
  monthly_amount: z.number(),
  current_period_end: z.string().nullable(),
  created_at: z.string(),
  product_key: z.string().nullable(),
  checkout_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
});

export const subscriptionStatusResultSchema = z.object({
  /** Platform access verdict: true while the subscription is `active` or `trialing`. */
  active: z.boolean(),
  /**
   * Stripe subscription status passed through verbatim, or `not_found`. Present
   * on active AND inactive responses (`past_due` stays `past_due`, never folded
   * into `active`). `undefined` on the `error` response, on platform responses
   * predating the field, AND when the platform reports a status this module does
   * not yet know (a future Stripe status): `.catch(undefined)` degrades the
   * unknown value to `undefined` rather than throwing, so an unrecognised status
   * never breaks the call — `active` (the platform's own access verdict) is still
   * honoured, and the subscriber-facing copy falls back to the `undefined` arm.
   * This file is framework-owned; a hard parse error here would break every
   * consuming app until a module release re-installs, which is the exact failure
   * this schema exists to prevent.
   */
  status: subscriptionStatusSchema.optional().catch(undefined),
  /** Plan label the subscription checkout was created with. Only when `active` is true. */
  plan: z.string().optional(),
  /** Recurring amount in USD as recorded by the platform. Only when `active` is true. */
  monthly_amount: z.number().optional(),
  /**
   * ISO timestamp of the current period end — the next renewal, or for a
   * `trialing` subscription the end of the trial. Only when `active` is true;
   * null when the platform holds no period evidence for that subscription.
   */
  current_period_end: z.string().nullable().optional(),
  /** Only when `active` is true. */
  customer_email: z.string().email().optional(),
  stripe_customer_id: z.string().nullable().optional(),
  product_key: z.string().optional(),
  /** Informational only: never grants access to the requested product. */
  has_unlinked_access: z.boolean().optional(),
  /** Matching subscriptions, newest first. Absent on older/identity-disabled responses. */
  subscriptions: z.array(subscriptionEntrySchema).optional(),
  /** Set when the request itself was invalid (e.g. `email is required`). */
  error: z.string().optional(),
});

// -- Runtime checkout (created from app code through Polsia's proxy) ---------

export const checkoutLineItemSchema = z.object({
  name: z.string().min(1),
  productKey: productKeySchema.optional(),
  amountUsd: z.number().min(0.5, 'each line item must be at least $0.50'),
  quantity: z.number().int().min(1).optional(),
});

/** Turns a checkout into a recurring SUBSCRIPTION. `amountUsd` is the per-period price. */
export const recurringConfigSchema = z.object({
  interval: z.enum(['month', 'year']),
});

export const createCheckoutSessionInputSchema = z
  .object({
    lineItems: z.array(checkoutLineItemSchema).min(1).optional(),
    amountUsd: z.number().min(1).optional(),
    /** Single-amount checkout only; carts put productKey on each line. */
    productKey: productKeySchema.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
    customerEmail: z.string().email().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    /**
     * Present → a recurring SUBSCRIPTION instead of a one-time charge. `amountUsd`
     * becomes the per-period price with the applicable per-invoice platform fee.
     * Subscriptions use the single-`amountUsd` path only (not `lineItems`).
     */
    recurring: recurringConfigSchema.optional(),
    /**
     * Force the buyer to enter a shipping address at checkout. Set this when the
     * app ships physical goods — the address comes back on the payment event
     * (`event.shipping`), so you always know where to ship. Leave unset for
     * digital goods, tickets, or subscriptions.
     */
    collectShippingAddress: z.boolean().optional(),
    /** ISO 3166-1 alpha-2 codes the buyer may ship to (default: a broad common set). */
    shippingCountries: z.array(z.string().length(2)).optional(),
    /**
     * Let buyers enter Stripe promotion/coupon codes at checkout. Works for both
     * one-time and subscription checkouts.
     */
    allowPromotionCodes: z.boolean().optional(),
    /**
     * Opaque reference you own (e.g. an order id or user id) echoed back on the
     * Stripe session — handy for reconciling a payment to your own record.
     */
    clientReferenceId: z.string().min(1).max(200).optional(),
    /**
     * Checkout UI language, e.g. `'auto'` (match the buyer's browser), `'en'`,
     * `'fr'`. Defaults to Stripe's behavior when unset.
     */
    locale: z.string().min(1).max(10).optional(),
    /**
     * `'auto'` collects a billing address only when required; `'required'`
     * always asks the buyer for one.
     */
    billingAddressCollection: z.enum(['auto', 'required']).optional(),
    /** Collect the buyer's phone number at checkout. */
    collectPhoneNumber: z.boolean().optional(),
    /**
     * Checkout submit-button style: `'auto'` | `'pay'` | `'book'` | `'donate'`.
     * One-time payments only — the platform ignores it for subscriptions.
     */
    submitType: z.enum(['auto', 'pay', 'book', 'donate']).optional(),
    /**
     * Free-trial length in days before the first subscription charge.
     * Subscriptions only (requires `recurring`) — the platform enforces this.
     */
    trialPeriodDays: z.number().int().min(1).max(730).optional(),
  })
  .refine((v) => Boolean(v.lineItems?.length) !== Boolean(v.amountUsd), {
    message: 'provide either lineItems or amountUsd, not both',
  })
  .refine((v) => !v.recurring || (v.amountUsd !== undefined && !v.lineItems?.length), {
    message: 'a subscription (recurring) requires amountUsd, not lineItems',
  })
  .refine((v) => v.productKey === undefined || !v.lineItems, {
    message: 'put productKey on each line item for a cart, not at the top level',
  });

export const checkoutSessionResultSchema = z.object({
  id: z.number(),
  stripeSessionId: z.string(),
  url: z.string().url(),
  totalAmountUsd: z.number(),
  companyReceives: z.number(),
  platformFee: z.number(),
  /** Set only for subscriptions: the per-invoice billing interval + a recurring marker. */
  billingInterval: z.enum(['month', 'year']).optional(),
  recurring: z.boolean().optional(),
  checkoutId: z.string().min(1).optional(),
  productIdentity: productIdentityCoverageSchema.optional(),
});

// -- Hosted customer portal (authenticated subscription management) --------

export const createCustomerPortalSessionInputSchema = z
  .object({
    customerEmail: z.string().email().optional(),
    stripeCustomerId: stripeCustomerIdSchema.optional(),
    returnUrl: z.string().url(),
  })
  .refine((v) => (v.customerEmail !== undefined) !== (v.stripeCustomerId !== undefined), {
    message: 'provide exactly one of customerEmail or stripeCustomerId',
  });

export const customerPortalSessionResultSchema = z.object({
  url: z.string().url(),
});

// -- Payment events feed (cursor-based fulfillment, no inbound callbacks) ----

/** Buyer's shipping address — present only when the checkout collected one. */
export const shippingAddressSchema = z.object({
  name: z.string().nullable(),
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
});

/**
 * Event types the feed serves. `payment_refunded` rows carry the refunded
 * purchase's `stripePaymentIntentId` and a positive refunded `grossAmountUsd`.
 */
export const PAYMENT_EVENT_TYPES = ['payment_received', 'payment_refunded'] as const;

/** Event helpers use camelCase, including nested items. Amounts remain minor units. */
export const paymentEventItemSchema = z.object({
  position: z.number().int(),
  productKey: z.string().nullable(),
  name: z.string(),
  quantity: z.number().int(),
  unitAmountMinor: z.number().int(),
  currency: z.string(),
  /** 'month' | 'year' | null today; a string, like `checkoutItemSchema.interval`. */
  interval: z.string().nullable(),
});

export const paymentEventSchema = z.object({
  id: z.number(),
  /** One of `PAYMENT_EVENT_TYPES`; kept a string so a future type never breaks parsing. */
  type: z.string(),
  /** Seller proceeds recorded by Polsia after applicable fees. */
  amountUsd: z.number().nullable(),
  /** Buyer-paid Checkout total; absent/null when no gross evidence is available. */
  grossAmountUsd: z.number().nullable().optional(),
  customerEmail: z.string().nullable(),
  description: z.string().nullable(),
  stripePaymentIntentId: z.string().nullable(),
  stripeCheckoutSessionId: z.string().nullable(),
  /** Where to ship, when the checkout collected a shipping address; else null. */
  shipping: shippingAddressSchema.nullable(),
  occurredAt: z.string(),
  /** 'one_time' | 'subscription_initial' | 'subscription_renewal'; kept a string so a future kind never breaks parsing. */
  kind: z.string().nullable().optional(),
  checkoutId: z.string().nullable().optional(),
  stripeCustomerId: z.string().nullable().optional(),
  stripeSubscriptionId: z.string().nullable().optional(),
  clientReferenceId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  items: z.array(paymentEventItemSchema).nullable().optional(),
});

export const paymentEventsResultSchema = z.object({
  events: z.array(paymentEventSchema),
  nextCursor: z.number(),
});

export type CheckoutVerificationResult = z.infer<typeof checkoutVerificationResultSchema>;
export type CheckoutItem = z.infer<typeof checkoutItemSchema>;
export type CheckoutOrder = z.infer<typeof checkoutOrderSchema>;
export type ProductIdentityCoverage = z.infer<typeof productIdentityCoverageSchema>;
export type SubscriptionEntry = z.infer<typeof subscriptionEntrySchema>;
export type PaymentEventItem = z.infer<typeof paymentEventItemSchema>;
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export type SubscriptionStatusResult = z.infer<typeof subscriptionStatusResultSchema>;
export type CheckoutLineItem = z.infer<typeof checkoutLineItemSchema>;
export type RecurringConfig = z.infer<typeof recurringConfigSchema>;
export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionInputSchema>;
export type CheckoutSessionResult = z.infer<typeof checkoutSessionResultSchema>;
export type CreateCustomerPortalSessionInput = z.infer<
  typeof createCustomerPortalSessionInputSchema
>;
export type CustomerPortalSessionResult = z.infer<typeof customerPortalSessionResultSchema>;
export type ShippingAddress = z.infer<typeof shippingAddressSchema>;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type PaymentEventsResult = z.infer<typeof paymentEventsResultSchema>;
