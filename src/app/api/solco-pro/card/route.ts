// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';
import { solcoProCardSchema } from '@/lib/contracts/solco-pro';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: Request) {
  const access = await requireSolcoPro(request);
  if (!access.allowed) return access.response;

  const entryId = new URL(request.url).searchParams.get('entry_id');
  if (!entryId || entryId.length > 128) {
    return NextResponse.json({ error: 'invalid_entry_id' }, { status: 400 });
  }

  try {
    const entry = await prisma.listeningEntry.findFirst({
      where: { id: entryId, userId: access.user.id },
      select: { albumName: true, artistName: true, listenedOn: true, rating: true, note: true },
    });
    if (!entry) {
      return NextResponse.json(
        { error: 'listening_not_found' },
        { status: 404, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      solcoProCardSchema.parse({
        listening: { ...entry, listenedOn: entry.listenedOn.toISOString().slice(0, 10) },
      }),
      { headers: privateHeaders },
    );
  } catch {
    return NextResponse.json(
      { error: 'pro_card_unavailable' },
      { status: 500, headers: privateHeaders },
    );
  }
}
