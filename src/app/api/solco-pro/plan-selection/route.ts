// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import {
  type SolcoFreePlanSelection,
  solcoBillingPeriodSchema,
  solcoPlanSelectionRequestSchema,
  solcoPlanSelectionResponseSchema,
} from '@/lib/contracts/solco-plan-selection';
import { prisma } from '@/lib/db';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', privateHeaders['Cache-Control']);
  headers.set('Pragma', privateHeaders.Pragma);
  const vary = headers.get('Vary');
  headers.set('Vary', vary ? `${vary}, Cookie` : privateHeaders.Vary);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function selectionFromRecord(
  record: {
    planId: string;
    billingPeriod: string;
    updatedAt: Date;
  } | null,
): SolcoFreePlanSelection | null {
  if (!record) return null;
  if (record.planId !== 'free') throw new Error('Unsupported plan selection.');

  return {
    planId: 'free',
    billingPeriod: solcoBillingPeriodSchema.parse(record.billingPeriod),
    amountEuroCents: 0,
    currency: 'EUR',
    state: 'active',
    selectedAt: record.updatedAt.toISOString(),
    renewalAt: null,
  };
}

export async function GET(request: Request) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return privateResponse(response as Response);
  }

  try {
    const record = await prisma.solcoPlanSelection.findUnique({
      where: { userId: user.id },
      select: { planId: true, billingPeriod: true, updatedAt: true },
    });
    const result = solcoPlanSelectionResponseSchema.parse({
      selection: selectionFromRecord(record),
    });
    return privateResponse(NextResponse.json(result));
  } catch {
    return privateResponse(
      NextResponse.json({ error: 'solco_plan_selection_unavailable' }, { status: 503 }),
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return privateResponse(NextResponse.json({ error: 'forbidden_origin' }, { status: 403 }));
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
    return privateResponse(NextResponse.json({ error: 'invalid_request' }, { status: 400 }));
  }

  const parsed = solcoPlanSelectionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return privateResponse(NextResponse.json({ error: 'invalid_request' }, { status: 400 }));
  }
  if (parsed.data.planId !== 'free') {
    return privateResponse(
      NextResponse.json(
        { error: 'solco_paid_plan_unavailable_until_eur_prices_are_verified' },
        { status: 409 },
      ),
    );
  }

  try {
    const existing = await prisma.solcoPlanSelection.findUnique({
      where: { userId: user.id },
      select: { planId: true },
    });
    if (existing && existing.planId !== 'free') {
      return privateResponse(
        NextResponse.json(
          { error: 'solco_contract_change_requires_provider_confirmation' },
          { status: 409 },
        ),
      );
    }

    const saved = await prisma.solcoPlanSelection.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        planId: 'free',
        billingPeriod: parsed.data.billingPeriod,
      },
      update: { billingPeriod: parsed.data.billingPeriod },
      select: { planId: true, billingPeriod: true, updatedAt: true },
    });
    const result = solcoPlanSelectionResponseSchema.parse({
      selection: selectionFromRecord(saved),
    });
    return privateResponse(NextResponse.json(result));
  } catch {
    return privateResponse(
      NextResponse.json({ error: 'solco_plan_selection_unavailable' }, { status: 503 }),
    );
  }
}
