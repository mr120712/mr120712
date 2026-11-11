// @polsia:user-owned — verifica che l'utente abbia Premium prima dello stream Jamendo.
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  if (!/^[0-9]{1,20}$/.test(trackId)) {
    return NextResponse.json(
      { allowed: false, reason: 'track_unavailable' },
      { status: 404, headers: privateHeaders },
    );
  }
  const access = await requireSolcoPro(request);
  if (!access.allowed) {
    const status = access.response.status;
    const reason =
      status === 401
        ? 'unauthorized'
        : status === 403
          ? 'premium_required'
          : 'entitlement_unavailable';
    return NextResponse.json({ allowed: false, reason }, { status, headers: privateHeaders });
  }
  return NextResponse.json({ allowed: true }, { headers: privateHeaders });
}
