// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicSourceStatusListSchema } from '@/lib/contracts/music';
import { getMusicSourceStatuses } from '@/lib/music/music-api.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const body = MusicSourceStatusListSchema.parse({ sources: getMusicSourceStatuses() });
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
}
