// @polsia:user-owned — avvia Stripe Checkout per un abbonamento (carte, PayPal e altri metodi attivi).
import 'server-only';
import { NextResponse } from 'next/server';
import { FREE_TRIAL_DAYS } from '@/lib/business/free-trial';
import { isTrialEligible } from '@/lib/business/free-trial.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  createSubscriptionCheckout,
  getUserSubscription,
  hasActiveSubscription,
} from '@/lib/business/stripe-subscriptions.server';
import {
  privateHeaders,
  signedIn,
  stripeErrorResponse,
} from '@/lib/business/subscription-routes.server';
import {
  SubscriptionCheckoutRequestSchema,
  SubscriptionCheckoutResponseSchema,
} from '@/lib/contracts/subscriptions';
import { sameOrigin } from '@/lib/same-origin';
import { siteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  const limited = await enforceRateLimit('subscriptions.checkout', `user:${auth.user.id}`);
  if (limited) return limited;
  const payload = await readJsonLimited(request, 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = SubscriptionCheckoutRequestSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_plan' }, { status: 400, headers: privateHeaders });
  }
  try {
    const existing = await getUserSubscription(auth.user.id);
    if (await hasActiveSubscription(auth.user.id)) {
      return NextResponse.json(
        {
          error: 'already_subscribed',
          message: 'Hai già un abbonamento attivo: cambialo da “Gestisci abbonamento”.',
        },
        { status: 409, headers: privateHeaders },
      );
    }
    const trialDays = (await isTrialEligible(auth.user.id)) ? FREE_TRIAL_DAYS : 0;
    const url = await createSubscriptionCheckout({
      userId: auth.user.id,
      email: auth.user.email,
      planId: body.data.planId,
      period: body.data.period,
      appUrl: siteUrl,
      customerId: existing?.stripeCustomerId ?? null,
      trialDays,
    });
    return NextResponse.json(SubscriptionCheckoutResponseSchema.parse({ url }), {
      headers: privateHeaders,
    });
  } catch (error) {
    return stripeErrorResponse(error);
  }
}
