// @polsia:user-owned — segnala una registrazione pubblicata (moderazione). Oltre la soglia si
// auto-ritira dalla classifica community.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { reportRecording } from '@/lib/music/recordings.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

const recordingIdPattern = /^[a-z0-9]{20,36}$/;

async function signedIn(request: Request): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;

  const { recordingId } = await params;
  if (!recordingIdPattern.test(recordingId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
  }

  const limited = await enforceRateLimit('library.write', `user:${auth.user.id}`);
  if (limited) return limited;

  const payload = await readJsonLimited(request, 256);
  if (!payload.ok && payload.status === 413) return limitedJsonError(payload);

  try {
    const ok = await reportRecording(recordingId, auth.user.id);
    if (!ok) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    }
    return NextResponse.json({ ok: true }, { headers: privateHeaders });
  } catch {
    return NextResponse.json(
      { error: 'recordings_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
