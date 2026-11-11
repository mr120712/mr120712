// @polsia:user-owned — il player chiede il permesso prima di avviare un brano (limite free).
// Solo verifica: l'ascolto viene registrato dalle route di stream quando l'audio parte davvero,
// così un brano che fallisce (verifica /playback, licenza, fonte giù) non costa nulla.
import 'server-only';
import { NextResponse } from 'next/server';
import { isValidPlayId } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { checkStreamPlay } from '@/lib/music/stream-play.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const payload = await readJsonLimited(request, 512);
  if (!payload.ok) return limitedJsonError(payload);
  const qualifiedId =
    payload.value && typeof payload.value === 'object'
      ? (payload.value as { qualifiedId?: unknown }).qualifiedId
      : null;
  if (typeof qualifiedId !== 'string' || !isValidPlayId(qualifiedId)) {
    return NextResponse.json({ error: 'invalid_track' }, { status: 400 });
  }
  // Same read-only decision as the stream routes (Jamendo switched off included); nothing written.
  const { decision } = await checkStreamPlay(qualifiedId);
  if (!decision.allowed) return playDeniedResponse(decision);
  return NextResponse.json(
    { allowed: true, used: decision.used, limit: decision.limit },
    { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
  );
}
