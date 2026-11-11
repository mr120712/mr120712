// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { getSolcoProReadiness } from '@/lib/business/solco-pro-entitlement';
import { solcoProPurchaseReadinessSchema } from '@/lib/contracts/solco-pro';

export const dynamic = 'force-dynamic';

export async function GET() {
  const result = solcoProPurchaseReadinessSchema.parse(getSolcoProReadiness());
  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
