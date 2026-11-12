// @polsia:user-owned — registra un ascolto di un brano pubblico (playCount della classifica).
// Non richiede login (anche gli anonimi ascoltano la libreria pubblica); same-origin per evitare
// gonfiaggi da terze parti.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { recordPublicUploadPlay } from '@/lib/music/public-uploads.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const idPattern = /^[a-z0-9]{20,40}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const { uploadId } = await params;
  if (!idPattern.test(uploadId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const identity = getRateLimitIdentity(null, request.headers) ?? 'anon';
  const limited = await enforceRateLimit('listening.write', `play:${identity}`);
  if (limited) return limited;

  await recordPublicUploadPlay(uploadId);
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
