// @polsia:user-owned
import { z } from 'zod';

export const solcoPlanIdSchema = z.enum(['free', 'premium', 'premium-plus', 'family']);

export const solcoProPlanPriceSchema = z
  .object({
    id: solcoPlanIdSchema,
    name: z.string().min(1),
    monthlyEuroCents: z.number().int().nonnegative(),
    annualEuroCents: z.number().int().nonnegative(),
    twelveMonthlyEuroCents: z.number().int().nonnegative(),
    annualSavingsEuroCents: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.twelveMonthlyEuroCents !== plan.monthlyEuroCents * 12) {
      context.addIssue({
        code: 'custom',
        message: 'Il totale mensile deve usare dodici mensilità.',
      });
    }
    if (plan.annualSavingsEuroCents !== plan.twelveMonthlyEuroCents - plan.annualEuroCents) {
      context.addIssue({
        code: 'custom',
        message: 'Il risparmio annuale non corrisponde al totale.',
      });
    }
  });

export const solcoProPricingSchema = z
  .object({
    plans: z.array(solcoProPlanPriceSchema).length(4),
    planBenefitsMapped: z.literal(false),
    stripePricesVerified: z.literal(false),
    purchaseAvailable: z.literal(false),
    billingChangesAvailable: z.literal(false),
  })
  .strict();

export type SolcoProPlanPrice = z.infer<typeof solcoProPlanPriceSchema>;
export type SolcoProPricing = z.infer<typeof solcoProPricingSchema>;
