// @polsia:user-owned
import {
  type SolcoProPlanPrice,
  type SolcoProPricing,
  solcoProPricingSchema,
} from '@/lib/contracts/solco-pro-pricing';

const requestedPlans = [
  { id: 'free', name: 'Free', monthlyEuroCents: 0, annualEuroCents: 0 },
  { id: 'premium', name: 'Premium', monthlyEuroCents: 499, annualEuroCents: 4999 },
  { id: 'premium-plus', name: 'Premium Plus', monthlyEuroCents: 799, annualEuroCents: 7999 },
  { id: 'family', name: 'Family', monthlyEuroCents: 1299, annualEuroCents: 12999 },
] as const;

export type SolcoProBillingPeriod = 'month' | 'year';

/** Selects the requested display amount; it does not represent a Stripe price mapping. */
export function getSolcoProDisplayedPrice(
  plan: Pick<SolcoProPlanPrice, 'monthlyEuroCents' | 'annualEuroCents'>,
  period: SolcoProBillingPeriod,
) {
  return period === 'month' ? plan.monthlyEuroCents : plan.annualEuroCents;
}

export function calculateSolcoProAnnualSavings(monthlyEuroCents: number, annualEuroCents: number) {
  const twelveMonthlyEuroCents = monthlyEuroCents * 12;
  const annualSavingsEuroCents = twelveMonthlyEuroCents - annualEuroCents;

  if (
    !Number.isInteger(monthlyEuroCents) ||
    !Number.isInteger(annualEuroCents) ||
    monthlyEuroCents < 0 ||
    annualEuroCents < 0 ||
    annualSavingsEuroCents < 0
  ) {
    throw new Error('Importi piano non validi.');
  }

  return { twelveMonthlyEuroCents, annualSavingsEuroCents };
}

function buildPlanPrices(): SolcoProPlanPrice[] {
  return requestedPlans.map((plan) => ({
    ...plan,
    ...calculateSolcoProAnnualSavings(plan.monthlyEuroCents, plan.annualEuroCents),
  }));
}

export function getSolcoProPricing(): SolcoProPricing {
  return solcoProPricingSchema.parse({
    plans: buildPlanPrices(),
    planBenefitsMapped: false,
    stripePricesVerified: false,
    purchaseAvailable: false,
    billingChangesAvailable: false,
  });
}
