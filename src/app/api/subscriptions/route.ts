// @polsia:user-owned — stato dell'abbonamento dell'utente e disponibilità dei pagamenti.
import 'server-only';
import { NextResponse } from 'next/server';
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
  const enabled = subscriptionsEnabled();
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json(SubscriptionStateSchema.parse({ enabled, subscription: null }), {
      headers: privateHeaders,
    });
  }
  try {
    const row = await getUserSubscription(user.id);
    const subscription = row
      ? {
          planId: row.planId,
          period: row.period,
          status: row.status,
          active: isSubscriptionActive(row),
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        }
      : null;
    return NextResponse.json(SubscriptionStateSchema.parse({ enabled, subscription }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(SubscriptionStateSchema.parse({ enabled, subscription: null }), {
      status: 503,
      headers: privateHeaders,
    });
  }
}
