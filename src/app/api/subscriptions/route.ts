// @polsia:user-owned — stato dell'abbonamento (Stripe o PayPal) e disponibilità dei pagamenti.
import 'server-only';
import { NextResponse } from 'next/server';
import { FREE_TRIAL_DAYS } from '@/lib/business/free-trial';
import { isTrialEligible } from '@/lib/business/free-trial.server';
import {
  getUserPayPalSubscription,
  isPayPalSubscriptionActive,
  paypalEnabled,
} from '@/lib/business/paypal-subscriptions.server';
import { evaluateRewards } from '@/lib/business/rewards.server';
import {
  getUserSubscription,
  isSubscriptionActive,
  subscriptionsEnabled,
} from '@/lib/business/stripe-subscriptions.server';
import { privateHeaders } from '@/lib/business/subscription-routes.server';
import { SubscriptionStateSchema } from '@/lib/contracts/subscriptions';
import { getSessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = { enabled: subscriptionsEnabled(), paypalEnabled: paypalEnabled() };
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json(
      SubscriptionStateSchema.parse({ ...base, trialDays: FREE_TRIAL_DAYS, subscription: null }),
      { headers: privateHeaders },
    );
  }
  try {
    const [stripe, paypal] = await Promise.all([
      getUserSubscription(user.id),
      getUserPayPalSubscription(user.id),
    ]);
    // A payment verified during the refresh above may complete an invite.
    await evaluateRewards(user.id).catch(() => undefined);
    const subscription =
      stripe && isSubscriptionActive(stripe)
        ? {
            provider: 'stripe' as const,
            planId: stripe.planId,
            period: stripe.period,
            status: stripe.status,
            active: true,
            currentPeriodEnd: stripe.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: stripe.cancelAtPeriodEnd,
          }
        : paypal && isPayPalSubscriptionActive(paypal)
          ? {
              provider: 'paypal' as const,
              planId: paypal.planId,
              period: paypal.period,
              status: paypal.status,
              active: true,
              currentPeriodEnd: paypal.nextBillingAt?.toISOString() ?? null,
              cancelAtPeriodEnd: false,
            }
          : null;
    const trialDays = (await isTrialEligible(user.id)) ? FREE_TRIAL_DAYS : 0;
    return NextResponse.json(SubscriptionStateSchema.parse({ ...base, trialDays, subscription }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(SubscriptionStateSchema.parse({ ...base, subscription: null }), {
      status: 503,
      headers: privateHeaders,
    });
  }
}
