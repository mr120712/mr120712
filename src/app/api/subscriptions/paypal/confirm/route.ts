// @polsia:user-owned — conferma lato server l'abbonamento approvato su PayPal.
import 'server-only';
import { NextResponse } from 'next/server';
import {
  confirmPayPalSubscription,
  isPayPalSubscriptionActive,
} from '@/lib/business/paypal-subscriptions.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { evaluateRewards } from '@/lib/business/rewards.server';
import {
  privateHeaders,
  signedIn,
  stripeErrorResponse,
} from '@/lib/business/subscription-routes.server';
import { PayPalConfirmRequestSchema } from '@/lib/contracts/subscriptions';
import { sameOrigin } from '@/lib/same-origin';

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
  const payload = await readJsonLimited(request, 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = PayPalConfirmRequestSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { error: 'invalid_subscription' },
      { status: 400, headers: privateHeaders },
    );
  }
  try {
    const row = await confirmPayPalSubscription(auth.user.id, body.data.subscriptionId);
    // First verified payment: converts the invite (if any) and assigns referral rewards.
    await evaluateRewards(auth.user.id).catch(() => undefined);
    return NextResponse.json(
      { planId: row.planId, period: row.period, active: isPayPalSubscriptionActive(row) },
      { headers: privateHeaders },
    );
  } catch (error) {
    return stripeErrorResponse(error);
  }
}
