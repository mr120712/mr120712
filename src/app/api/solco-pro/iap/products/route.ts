// @polsia:user-owned — catalogo degli acquisti in-app per la paywall dell'app, con il token di
// account (UUID) che l'app deve passare allo store per legare l'acquisto a questo utente.
import 'server-only';
import { NextResponse } from 'next/server';
import { iapAccountToken } from '@/lib/business/iap/account-token';
import { IAP_PRODUCTS } from '@/lib/business/iap/catalog';
import { iapReadiness } from '@/lib/business/iap/config.server';
import { iapProductsResponseSchema } from '@/lib/contracts/solco-pro-iap';
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

  const readiness = iapReadiness();
  return NextResponse.json(
    iapProductsResponseSchema.parse({
      available: readiness.available,
      platforms: { apple: readiness.apple, google: readiness.google },
      products: IAP_PRODUCTS.map((product) => ({
        productId: product.productId,
        planId: product.planId,
        period: product.period,
        label: product.label,
      })),
      accountToken: iapAccountToken(user.id),
    }),
    { headers: privateHeaders },
  );
}
