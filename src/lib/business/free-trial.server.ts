// @polsia:user-owned — chi può ancora usare la prova gratuita.
import 'server-only';
import { prisma } from '@/lib/db';

/** La prova vale una sola volta: solo per chi non ha mai avuto un abbonamento Stripe o PayPal. */
export async function isTrialEligible(userId: string) {
  const [stripe, paypal] = await Promise.all([
    prisma.solcoSubscription.count({ where: { userId } }),
    prisma.payPalSubscription.count({ where: { userId } }),
  ]);
  return stripe + paypal === 0;
}
