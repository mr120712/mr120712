// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { ListeningUsageResponseSchema } from '@/lib/contracts/music';
import { prisma } from '@/lib/db';
import { createListeningUsage, getListeningCalendarMonth } from '@/lib/music/listening-quota';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  try {
    const now = new Date();
    const month = getListeningCalendarMonth(now);
    const used = await prisma.listeningEntry.count({
      where: {
        userId: user.id,
        createdAt: { gte: month.start, lt: month.end },
      },
    });
    return NextResponse.json(
      ListeningUsageResponseSchema.parse({ usage: createListeningUsage(used, now) }),
    );
  } catch {
    return NextResponse.json(
      { error: 'Non è stato possibile verificare il limite mensile.' },
      { status: 500 },
    );
  }
}
