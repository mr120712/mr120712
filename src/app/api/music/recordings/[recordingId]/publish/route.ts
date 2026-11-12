// @polsia:user-owned — pubblica o ritira una registrazione per la classifica community.
// Solo il proprietario; privato di default. Pubblicare la rende ascoltabile dagli altri utenti.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { RecordingPublishResponseSchema, RecordingPublishSchema } from '@/lib/contracts/recordings';
import { setRecordingPublished } from '@/lib/music/recordings.server';
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

  const payload = await readJsonLimited(request, 512);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = RecordingPublishSchema.safeParse(payload.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: privateHeaders });
  }

  try {
    const recording = await setRecordingPublished(auth.user.id, recordingId, parsed.data.published);
    if (!recording) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
    }
    return NextResponse.json(RecordingPublishResponseSchema.parse({ recording }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'recordings_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
