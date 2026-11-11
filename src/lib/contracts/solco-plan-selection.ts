// @polsia:user-owned
import { z } from 'zod';

export const solcoBillingPeriodSchema = z.enum(['month', 'year']);
export const solcoPlanSelectionRequestSchema = z
  .object({
    planId: z.enum(['free', 'premium', 'premium-plus', 'family']),
    billingPeriod: solcoBillingPeriodSchema,
  })
  .strict();

export const solcoFreePlanSelectionSchema = z
  .object({
    planId: z.literal('free'),
    billingPeriod: solcoBillingPeriodSchema,
    amountEuroCents: z.literal(0),
    currency: z.literal('EUR'),
    state: z.literal('active'),
    selectedAt: z.string().datetime(),
    renewalAt: z.null(),
  })
  .strict();

export const solcoPlanSelectionResponseSchema = z
  .object({ selection: solcoFreePlanSelectionSchema.nullable() })
  .strict();

export type SolcoBillingPeriod = z.infer<typeof solcoBillingPeriodSchema>;
export type SolcoPlanSelectionRequest = z.infer<typeof solcoPlanSelectionRequestSchema>;
export type SolcoFreePlanSelection = z.infer<typeof solcoFreePlanSelectionSchema>;
export type SolcoPlanSelectionResponse = z.infer<typeof solcoPlanSelectionResponseSchema>;
