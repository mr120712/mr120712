// @polsia:user-owned — portale Stripe per cambiare piano, metodo di pagamento o disdire.
import 'server-only';
import { NextResponse } from 'next/server';
import {
  createBillingPortal,
  getUserSubscription,
} from '@/lib/business/stripe-subscriptions.server';
import {
  privateHeaders,
  signedIn,
  stripeErrorResponse,
} from '@/lib/business/subscription-routes.server';
import { SubscriptionPortalResponseSchema } from '@/lib/contracts/subscriptions';
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
  try {
    const row = await getUserSubscription(auth.user.id);
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    }
    const url = await createBillingPortal(row.stripeCustomerId, `${siteUrl}/piani`);
    return NextResponse.json(SubscriptionPortalResponseSchema.parse({ url }), {
      headers: privateHeaders,
    });
  } catch (error) {
    return stripeErrorResponse(error);
  }
}
