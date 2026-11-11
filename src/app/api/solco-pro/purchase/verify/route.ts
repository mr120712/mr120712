// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  getSolcoProReadiness,
  persistVerifiedSolcoProPurchase,
} from '@/lib/business/solco-pro-entitlement';
import {
  solcoProPurchaseVerificationRequestSchema,
  solcoProPurchaseVerificationResponseSchema,
} from '@/lib/contracts/solco-pro';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

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

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }

  let user: Awaited<ReturnType<typeof requireAuth>>;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return privateResponse(response as Response);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: privateHeaders },
    );
  }

  const parsed = solcoProPurchaseVerificationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_session_id' },
      { status: 400, headers: privateHeaders },
    );
  }

  try {
    const result = await persistVerifiedSolcoProPurchase({
      userId: user.id,
      sessionId: parsed.data.sessionId,
    });
    if (!result.confirmed) {
      const status =
        result.reason === 'checkout_unavailable'
          ? {
              ...getSolcoProReadiness(),
              reason: 'configuration_missing' as const,
            }
          : {
              state: 'unconfirmed' as const,
              reason: 'authoritative_confirmation_missing' as const,
            };
      return NextResponse.json(solcoProPurchaseVerificationResponseSchema.parse(status), {
        headers: privateHeaders,
      });
    }

    const response = solcoProPurchaseVerificationResponseSchema.parse({
      state: 'active',
      validUntil: result.entitlement.validUntil.toISOString(),
    });
    return NextResponse.json(response, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'verification_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
