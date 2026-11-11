// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  try {
    await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  return NextResponse.json(
    { error: 'solco_pro_payment_management_unavailable' },
    { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
