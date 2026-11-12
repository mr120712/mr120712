// @polsia:user-owned — segnala un brano pubblico (moderazione). Oltre la soglia di segnalatori
// distinti il brano si auto-ritira dalla libreria pubblica.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { reportPublicUpload } from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

const idPattern = /^[a-z0-9]{20,40}$/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (response) {
    return response as Response;
  }

  const { uploadId } = await params;
  if (!idPattern.test(uploadId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
  }

  const limited = await enforceRateLimit('library.write', `user:${userId}`);
  if (limited) return limited;

  const payload = await readJsonLimited(request, 256);
  if (!payload.ok && payload.status === 413) return limitedJsonError(payload);

  try {
    const ok = await reportPublicUpload(uploadId, userId);
    if (!ok) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    }
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'uploads_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
