import { describe, expect, it } from 'vitest';
import {
  calculateSolcoProAnnualSavings,
  getSolcoProDisplayedPrice,
  getSolcoProPricing,
} from '@/lib/business/solco-pro-pricing';

describe('prezzi informativi dei piani Solco', () => {
  it('mantiene ordine e importi richiesti in centesimi', () => {
    const pricing = getSolcoProPricing();

    expect(
      pricing.plans.map(({ id, name, monthlyEuroCents, annualEuroCents }) => ({
        id,
        name,
        monthlyEuroCents,
        annualEuroCents,
      })),
    ).toEqual([
      { id: 'free', name: 'Free', monthlyEuroCents: 0, annualEuroCents: 0 },
      { id: 'premium', name: 'Premium', monthlyEuroCents: 499, annualEuroCents: 4999 },
      { id: 'premium-plus', name: 'Premium Plus', monthlyEuroCents: 799, annualEuroCents: 7999 },
      { id: 'family', name: 'Family', monthlyEuroCents: 1299, annualEuroCents: 12999 },
    ]);
  });

  it.each([
    ['Free', 0, 0, 0, 0],
    ['Premium', 499, 4999, 5988, 989],
    ['Premium Plus', 799, 7999, 9588, 1589],
    ['Family', 1299, 12999, 15588, 2589],
  ])(
    'calcola in centesimi il confronto e il risparmio annuale per %s',
    (_name, monthly, yearly, twelveMonthly, savings) => {
      expect(calculateSolcoProAnnualSavings(monthly, yearly)).toEqual({
        twelveMonthlyEuroCents: twelveMonthly,
        annualSavingsEuroCents: savings,
      });
    },
  );

  it.each([
    ['free', 'month', 0],
    ['free', 'year', 0],
    ['premium', 'month', 499],
    ['premium', 'year', 4999],
    ['premium-plus', 'month', 799],
    ['premium-plus', 'year', 7999],
    ['family', 'month', 1299],
    ['family', 'year', 12999],
  ] as const)('seleziona solo l’importo informativo richiesto: %s / %s', (id, period, expected) => {
    const plan = getSolcoProPricing().plans.find((item) => item.id === id);
    if (!plan) throw new Error(`Piano mancante: ${id}`);
    expect(getSolcoProDisplayedPrice(plan, period)).toBe(expected);
  });

  it('non attribuisce benefit e non segnala prezzi o acquisti Stripe verificati', () => {
    expect(getSolcoProPricing()).toMatchObject({
      planBenefitsMapped: false,
      stripePricesVerified: false,
      purchaseAvailable: false,
      billingChangesAvailable: false,
    });
  });

  it('rifiuta importi non interi, negativi o un prezzo annuale superiore a dodici mensilità', () => {
    expect(() => calculateSolcoProAnnualSavings(4.99, 499)).toThrow('Importi piano non validi.');
    expect(() => calculateSolcoProAnnualSavings(-1, 0)).toThrow('Importi piano non validi.');
    expect(() => calculateSolcoProAnnualSavings(100, 1201)).toThrow('Importi piano non validi.');
  });
});
