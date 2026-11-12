// @polsia:user-owned — stato dell'abbonamento in-app dell'utente (ri-verifica pigra presso lo store).
import 'server-only';
import { NextResponse } from 'next/server';
import { getIapSubscriptionStatus } from '@/lib/business/iap/entitlement.server';
import { iapStatusResponseSchema } from '@/lib/contracts/solco-pro-iap';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

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
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return privateResponse(response as Response);
  }

  try {
    const status = await getIapSubscriptionStatus(user.id);
    return NextResponse.json(
      iapStatusResponseSchema.parse({
        active: status.active,
        validUntil: status.validUntil ? status.validUntil.toISOString() : null,
        planId: status.planId,
      }),
      { headers: privateHeaders },
    );
  } catch {
    return NextResponse.json(
      { error: 'status_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
