// @polsia:user-owned — elimina un brano registrato (solo il proprietario).
import 'server-only';
import { NextResponse } from 'next/server';
import { deleteRecording } from '@/lib/music/recordings.server';
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

export async function DELETE(
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

  try {
    const removed = await deleteRecording(auth.user.id, recordingId);
    if (!removed) {
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
