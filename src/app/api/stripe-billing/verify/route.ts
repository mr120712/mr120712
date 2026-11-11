// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/stripe-billing@0.9.0. Drift = commit rejected.
//
// GET /api/stripe-billing/verify?session_id=...
// Public success-page verification route. It verifies the Stripe checkout
// session against Polsia's company-payment records using server-only proxy env.

import 'server-only';
import { NextResponse } from 'next/server';
import {
  StripeBillingConfigurationError,
  verifyCheckoutSession,
} from '@/lib/stripe-billing/client';
import { checkoutSessionQuerySchema } from '@/lib/stripe-billing/schema';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId =
    url.searchParams.get('session_id') ?? url.searchParams.get('checkout_session_id') ?? '';
  const result = checkoutSessionQuerySchema.safeParse({ session_id: sessionId });

  if (!result.success) {
    return NextResponse.json(
      { verified: false, error: result.error.flatten().fieldErrors.session_id?.[0] },
      { status: 400 },
    );
  }

  try {
    const verification = await verifyCheckoutSession({ sessionId: result.data.session_id });
    // Keep the public success-page contract. Private order metadata and billing
    // identities are available only through the server helper after app authorization.
    return NextResponse.json({
      verified: verification.verified,
      ...(verification.payment !== undefined ? { payment: verification.payment } : {}),
      ...(verification.error !== undefined ? { error: verification.error } : {}),
    });
  } catch (err) {
    if (err instanceof StripeBillingConfigurationError) {
      return NextResponse.json(
        { verified: false, error: 'stripe_billing_not_configured' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { verified: false, error: 'payment_verification_failed' },
      { status: 502 },
    );
  }
}
