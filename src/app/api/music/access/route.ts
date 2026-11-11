// @polsia:user-owned — dice al player se l'utente ha ascolto completo e in background.
import 'server-only';
import { NextResponse } from 'next/server';
import { currentAccess } from '@/lib/business/premium-access.server';
import { PREVIEW_SECONDS } from '@/lib/music/preview-stream.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { premium, signedIn } = await currentAccess();
  return NextResponse.json(
    { premium, signedIn, previewSeconds: premium ? null : PREVIEW_SECONDS },
    { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
  );
}
