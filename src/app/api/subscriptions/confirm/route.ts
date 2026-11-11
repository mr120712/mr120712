// @polsia:user-owned — conferma lato server il checkout completato (verifica su Stripe).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { evaluateRewards } from '@/lib/business/rewards.server';
import {
  confirmSubscriptionCheckout,
  isSubscriptionActive,
} from '@/lib/business/stripe-subscriptions.server';
import {
  privateHeaders,
  signedIn,
  stripeErrorResponse,
} from '@/lib/business/subscription-routes.server';
import { SubscriptionConfirmRequestSchema } from '@/lib/contracts/subscriptions';
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
  // Each call reaches Stripe/PayPal: cap repeated confirmations per account.
  const limited = await enforceRateLimit(
    'subscriptions.sync',
    getRateLimitIdentity(auth.user.id, request.headers),
  );
  if (limited) return limited;
  const payload = await readJsonLimited(request, 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = SubscriptionConfirmRequestSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { error: 'invalid_session' },
      { status: 400, headers: privateHeaders },
    );
  }
  try {
    const row = await confirmSubscriptionCheckout(auth.user.id, body.data.sessionId);
    // First verified payment: converts the invite (if any) and assigns referral rewards.
    await evaluateRewards(auth.user.id).catch(() => undefined);
    return NextResponse.json(
      { planId: row.planId, period: row.period, active: isSubscriptionActive(row) },
      { headers: privateHeaders },
    );
  } catch (error) {
    return stripeErrorResponse(error);
  }
}
