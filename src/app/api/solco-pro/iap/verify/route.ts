// @polsia:user-owned — verifica un acquisto in-app (Apple/Google) e, se valido, concede Pro.
import 'server-only';
import { NextResponse } from 'next/server';
import { verifyAndPersistIapPurchase } from '@/lib/business/iap/entitlement.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { evaluateRewards } from '@/lib/business/rewards.server';
import { iapVerifyRequestSchema, iapVerifyResponseSchema } from '@/lib/contracts/solco-pro-iap';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024;
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

  const limited = await enforceRateLimit(
    'iap.verify',
    getRateLimitIdentity(user.id, request.headers),
  );
  if (limited) return privateResponse(limited);

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.status === 413
      ? privateResponse(limitedJsonError(body))
      : NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: privateHeaders });
  }

  const parsed = iapVerifyRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: privateHeaders },
    );
  }

  try {
    const result = await verifyAndPersistIapPurchase({
      userId: user.id,
      platform: parsed.data.platform,
      productId: parsed.data.productId,
      token: parsed.data.token,
    });

    if (!result.confirmed) {
      const status =
        result.reason === 'store_error' || result.reason === 'not_configured' ? 503 : 200;
      return NextResponse.json(
        iapVerifyResponseSchema.parse({ ok: false, reason: result.reason }),
        { status, headers: privateHeaders },
      );
    }

    // Primo pagamento verificato: converte l'invito (se c'è) e assegna le ricompense referral.
    if (result.firstPaid) await evaluateRewards(user.id).catch(() => undefined);

    return NextResponse.json(
      iapVerifyResponseSchema.parse({
        ok: true,
        active: result.active,
        validUntil: result.validUntil ? result.validUntil.toISOString() : null,
        planId: result.planId,
      }),
      { headers: privateHeaders },
    );
  } catch {
    return NextResponse.json(
      { error: 'verification_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
