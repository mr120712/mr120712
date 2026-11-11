// @polsia:user-owned
import { z } from 'zod';

export const solcoProEntitlementStatusSchema = z.object({
  state: z.enum(['active', 'locked', 'unavailable']),
  validUntil: z.string().datetime().nullable(),
  purchase: z
    .object({
      planId: z.literal('solco-pro'),
      paymentMode: z.literal('payment'),
      amountEuroCents: z.literal(2400),
      currency: z.literal('EUR'),
      validUntil: z.string().datetime(),
      renewalAt: z.null(),
    })
    .strict()
    .nullable(),
});
export const solcoProThemeSchema = z.enum(['default', 'blue-hour', 'amber']);
export const solcoProThemeRequestSchema = z.object({ theme: solcoProThemeSchema }).strict();
export const solcoProStatisticsSchema = z.object({
  totalListens: z.number().int().nonnegative(),
  uniqueAlbums: z.number().int().nonnegative(),
  uniqueArtists: z.number().int().nonnegative(),
  averageRating: z.number().min(1).max(5).nullable(),
  topArtist: z.string().nullable(),
  topContext: z.string().nullable(),
  monthlyListens: z.array(z.object({ month: z.string(), count: z.number().int().nonnegative() })),
});
export const solcoProOverviewSchema = z.object({
  theme: solcoProThemeSchema,
  statistics: solcoProStatisticsSchema,
});
export const solcoProThemeResponseSchema = z.object({ theme: solcoProThemeSchema });
export const solcoProCardSchema = z.object({
  listening: z.object({
    albumName: z.string().min(1),
    artistName: z.string().min(1),
    listenedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rating: z.number().min(1).max(5),
    note: z.string().min(1),
  }),
});

export const solcoProCheckoutMissingRequirementSchema = z.enum([
  'stripe_configuration',
  'stripe_onboarding',
  'stripe_eur_checkout',
  'stripe_eur_verification',
  'stripe_bank_payout',
]);
export const solcoProStripeBusinessAccountStatusSchema = z.object({
  exists: z.boolean(),
  chargesEnabled: z.boolean(),
  accountStatus: z.enum(['complete', 'incomplete', 'unknown']),
});
export const solcoProPurchaseReadinessSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    businessAccount: solcoProStripeBusinessAccountStatusSchema,
  }),
  z.object({
    state: z.literal('unavailable'),
    missing: z.array(solcoProCheckoutMissingRequirementSchema),
    businessAccount: solcoProStripeBusinessAccountStatusSchema,
  }),
]);
export const solcoProCheckoutResponseSchema = z.object({ url: z.string().url() });
export const solcoProPurchaseVerificationRequestSchema = z
  .object({ sessionId: z.string().trim().min(1).max(255) })
  .strict();
export const solcoProCheckoutStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('active'),
    validUntil: z.string().datetime(),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum(['configuration_missing', 'verification_error']),
    missing: z.array(solcoProCheckoutMissingRequirementSchema),
  }),
  z.object({
    state: z.literal('unconfirmed'),
    reason: z.literal('authoritative_confirmation_missing'),
  }),
]);
export const solcoProPurchaseVerificationResponseSchema = solcoProCheckoutStatusSchema;

export type SolcoProCheckoutStatus = z.infer<typeof solcoProCheckoutStatusSchema>;
export type SolcoProCheckoutMissingRequirement = z.infer<
  typeof solcoProCheckoutMissingRequirementSchema
>;
export type SolcoProPurchaseReadiness = z.infer<typeof solcoProPurchaseReadinessSchema>;
export type SolcoProEntitlementStatus = z.infer<typeof solcoProEntitlementStatusSchema>;
export type SolcoProStripeBusinessAccountStatus = z.infer<
  typeof solcoProStripeBusinessAccountStatusSchema
>;
export type SolcoProTheme = z.infer<typeof solcoProThemeSchema>;
export type SolcoProStatistics = z.infer<typeof solcoProStatisticsSchema>;
export type SolcoProOverview = z.infer<typeof solcoProOverviewSchema>;
export type SolcoProCard = z.infer<typeof solcoProCardSchema>;
