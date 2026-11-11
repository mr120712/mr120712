// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { findActiveSolcoProEntitlement } from '@/lib/business/solco-pro-entitlement';
import { getSolcoProCheckoutMissingRequirements } from '@/lib/business/solco-pro-purchase-policy';
import {
  type SolcoProCheckoutStatus,
  solcoProCheckoutStatusSchema,
} from '@/lib/contracts/solco-pro';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', privateHeaders['Cache-Control']);
  const vary = headers.get('Vary');
  headers.set('Vary', vary ? `${vary}, Cookie` : privateHeaders.Vary);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET(request: Request) {
  try {
    const user = await requireAuth(request);
    const entitlement = await findActiveSolcoProEntitlement(user.id);
    let status: SolcoProCheckoutStatus;

    if (entitlement) {
      status = {
        state: 'active',
        validUntil: entitlement.validUntil.toISOString(),
      };
    } else {
      const missing = getSolcoProCheckoutMissingRequirements();
      status =
        missing.length > 0
          ? { state: 'unavailable', reason: 'configuration_missing', missing }
          : { state: 'unconfirmed', reason: 'authoritative_confirmation_missing' };
    }

    return NextResponse.json(solcoProCheckoutStatusSchema.parse(status), {
      headers: privateHeaders,
    });
  } catch (error) {
    if (error instanceof Response) return privateResponse(error);
    const status: SolcoProCheckoutStatus = {
      state: 'unavailable',
      reason: 'verification_error',
      missing: [],
    };
    return NextResponse.json(solcoProCheckoutStatusSchema.parse(status), {
      status: 503,
      headers: privateHeaders,
    });
  }
}
