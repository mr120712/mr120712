// @polsia:user-owned — contratti per gli abbonamenti Stripe (Premium, Premium Plus, Family).
import { z } from 'zod';

export const PaidPlanIdSchema = z.enum(['premium', 'premium-plus', 'family']);
export type PaidPlanId = z.infer<typeof PaidPlanIdSchema>;
export const BillingPeriodSchema = z.enum(['month', 'year']);
export type BillingPeriod = z.infer<typeof BillingPeriodSchema>;

export const SubscriptionCheckoutRequestSchema = z.object({
  planId: PaidPlanIdSchema,
  period: BillingPeriodSchema,
});

export const SubscriptionCheckoutResponseSchema = z.object({ url: z.string().url() });

export const SubscriptionConfirmRequestSchema = z.object({
  sessionId: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/),
});

export const SubscriptionStateSchema = z.object({
  enabled: z.boolean(),
  paypalEnabled: z.boolean(),
  subscription: z
    .object({
      provider: z.enum(['stripe', 'paypal']),
      planId: PaidPlanIdSchema,
      period: BillingPeriodSchema,
      status: z.string(),
      active: z.boolean(),
      currentPeriodEnd: z.string().datetime().nullable(),
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
});
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

export const SubscriptionPortalResponseSchema = z.object({ url: z.string().url() });

export const PayPalConfirmRequestSchema = z.object({
  subscriptionId: z.string().regex(/^I-[A-Z0-9]{6,40}$/),
});
