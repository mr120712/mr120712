// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { findActiveSolcoProEntitlement } from '@/lib/business/solco-pro-entitlement';
import { solcoProEntitlementStatusSchema } from '@/lib/contracts/solco-pro';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  try {
    const entitlement = await findActiveSolcoProEntitlement(user.id);
    const result = solcoProEntitlementStatusSchema.parse({
      state: entitlement ? 'active' : 'locked',
      validUntil: entitlement?.validUntil?.toISOString() ?? null,
      purchase: entitlement
        ? {
            planId: 'solco-pro',
            paymentMode: 'payment',
            amountEuroCents: entitlement.amountEuroCents,
            currency: entitlement.currency,
            validUntil: entitlement.validUntil.toISOString(),
            renewalAt: null,
          }
        : null,
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch {
    return NextResponse.json(
      solcoProEntitlementStatusSchema.parse({
        state: 'unavailable',
        validUntil: null,
        purchase: null,
      }),
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
