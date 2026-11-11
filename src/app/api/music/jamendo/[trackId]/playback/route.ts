// @polsia:user-owned — il catalogo Jamendo è gratuito per tutti: nessuna verifica di abbonamento.
import 'server-only';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = await params;
  if (!/^[0-9]{1,20}$/.test(trackId)) {
    return NextResponse.json({ allowed: false, reason: 'track_unavailable' }, { status: 404 });
  }
  return NextResponse.json({ allowed: true }, { headers: { 'Cache-Control': 'no-store' } });
}
