// @polsia:user-owned — avvia un abbonamento PayPal e restituisce il link di approvazione.
import 'server-only';
import { NextResponse } from 'next/server';
import { createPayPalSubscription } from '@/lib/business/paypal-subscriptions.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { hasActiveSubscription } from '@/lib/business/stripe-subscriptions.server';
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
    if (await hasActiveSubscription(auth.user.id)) {
      return NextResponse.json(
        { error: 'already_subscribed', message: 'Hai già un abbonamento attivo.' },
        { status: 409, headers: privateHeaders },
      );
    }
    const url = await createPayPalSubscription({
      userId: auth.user.id,
      planId: body.data.planId,
      period: body.data.period,
      appUrl: siteUrl,
    });
    return NextResponse.json(SubscriptionCheckoutResponseSchema.parse({ url }), {
      headers: privateHeaders,
    });
  } catch (error) {
    return stripeErrorResponse(error);
  }
}
