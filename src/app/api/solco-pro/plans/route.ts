// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import { solcoProPricingSchema } from '@/lib/contracts/solco-pro-pricing';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: Request) {
  try {
    await requireAuth(request);
  } catch (response) {
    const denied = response as Response;
    const headers = new Headers(denied.headers);
    headers.set('Cache-Control', privateHeaders['Cache-Control']);
    const vary = headers.get('Vary');
    headers.set('Vary', vary ? `${vary}, Cookie` : privateHeaders.Vary);
    return new Response(denied.body, {
      status: denied.status,
      statusText: denied.statusText,
      headers,
    });
  }

  return NextResponse.json(solcoProPricingSchema.parse(getSolcoProPricing()), {
    headers: privateHeaders,
  });
}
