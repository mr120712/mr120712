// @polsia:user-owned — stream Jamendo per gli abbonati Premium (redirect al file ufficiale).
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';
import { resolveJamendoAudio } from '@/lib/music/jamendo.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  const access = await requireSolcoPro(request);
  if (!access.allowed) return access.response;
  const url = await resolveJamendoAudio(trackId);
  if (!url) return NextResponse.json({ error: 'track_unavailable' }, { status: 404 });
  return NextResponse.redirect(url, {
    status: 302,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}
