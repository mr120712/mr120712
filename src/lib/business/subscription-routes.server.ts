// @polsia:user-owned — utilità condivise dalle route degli abbonamenti.
import 'server-only';
import { NextResponse } from 'next/server';
import { PayPalSubscriptionError } from '@/lib/business/paypal-subscriptions.server';
import { StripeSubscriptionError } from '@/lib/business/stripe-subscriptions.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

export async function signedIn(
  request: Request,
): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

export function stripeErrorResponse(error: unknown) {
  if (error instanceof StripeSubscriptionError || error instanceof PayPalSubscriptionError) {
    const status =
      error.code === 'not_configured'
        ? 503
        : error.code === 'not_found'
          ? 404
          : error.code === 'account_mismatch'
            ? 403
            : error.code === 'incomplete'
              ? 409
              : 502;
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status, headers: privateHeaders },
    );
  }
  return NextResponse.json(
    { error: 'payments_unavailable', message: 'Pagamenti non disponibili. Riprova.' },
    { status: 503, headers: privateHeaders },
  );
}
