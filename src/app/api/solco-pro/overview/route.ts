// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';
import { calculateSolcoProStatistics } from '@/lib/business/solco-pro-statistics';
import {
  solcoProOverviewSchema,
  solcoProThemeRequestSchema,
  solcoProThemeSchema,
} from '@/lib/contracts/solco-pro';
import { prisma } from '@/lib/db';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireSolcoPro(request);
  if (!access.allowed) return access.response;

  try {
    const [preference, entries] = await Promise.all([
      prisma.solcoProPreference.findUnique({ where: { userId: access.user.id } }),
      prisma.listeningEntry.findMany({
        where: { userId: access.user.id },
        select: { albumId: true, artistName: true, rating: true, listenedOn: true, context: true },
      }),
    ]);
    const data = solcoProOverviewSchema.parse({
      theme: solcoProThemeSchema.parse(preference?.theme ?? 'default'),
      statistics: calculateSolcoProStatistics(entries),
    });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'pro_data_unavailable' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  const access = await requireSolcoPro(request);
  if (!access.allowed) return access.response;

  const body = await request.json().catch(() => null);
  const parsed = solcoProThemeRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_theme' }, { status: 400 });

  try {
    const preference = await prisma.solcoProPreference.upsert({
      where: { userId: access.user.id },
      update: { theme: parsed.data.theme },
      create: { userId: access.user.id, theme: parsed.data.theme },
    });
    return NextResponse.json({ theme: solcoProThemeSchema.parse(preference.theme) });
  } catch {
    return NextResponse.json({ error: 'pro_preference_unavailable' }, { status: 500 });
  }
}
