// @polsia:user-owned — stato del collegamento a TikTok (GET) e scollegamento (DELETE, stessa
// origine). Solo amministratori verificati. Non espone mai i token: solo stato, open_id e scope.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireVerifiedMusicRightsAdmin } from '@/lib/music/rights-admin.server';
import { sameOrigin } from '@/lib/same-origin';
import { tiktokConfig, tiktokPrivateHeaders } from '@/lib/tiktok/config.server';
import { connectionSummary, deleteConnection } from '@/lib/tiktok/connection.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  if (!tiktokConfig()) {
    return NextResponse.json(
      { configured: false, state: 'none', openId: null, scope: null, updatedAt: null },
      { headers: tiktokPrivateHeaders },
    );
  }
  const summary = await connectionSummary(access.user.id);
  return NextResponse.json({ configured: true, ...summary }, { headers: tiktokPrivateHeaders });
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: tiktokPrivateHeaders },
    );
  }
  const access = await requireVerifiedMusicRightsAdmin(request);
  if (!access.allowed) return access.response;
  await deleteConnection(access.user.id);
  return NextResponse.json({ disconnected: true }, { headers: tiktokPrivateHeaders });
}
