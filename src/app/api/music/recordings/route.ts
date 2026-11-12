// @polsia:user-owned — brani registrati dall'utente sul sito: elenco (GET) e registrazione (POST).
// Il file audio è già in archivio privato; qui si ispeziona e si salva solo il riferimento.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  RecordingCreateResponseSchema,
  RecordingCreateSchema,
  RecordingListResponseSchema,
} from '@/lib/contracts/recordings';
import {
  InvalidRecordingSource,
  listRecordings,
  RecordingLimitReached,
  registerRecording,
} from '@/lib/music/recordings.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

async function signedIn(request: Request): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

export async function GET(request: Request) {
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  try {
    const recordings = await listRecordings(auth.user.id);
    return NextResponse.json(RecordingListResponseSchema.parse({ recordings }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'recordings_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  const userId = auth.user.id;

  const limited = await enforceRateLimit('recordings.write', `user:${userId}`);
  if (limited) return limited;

  const payload = await readJsonLimited(request, 4096);
  if (!payload.ok) return limitedJsonError(payload);

  const parsed = RecordingCreateSchema.safeParse(payload.value);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && !errors[field]) errors[field] = issue.message;
    }
    return NextResponse.json({ errors }, { status: 400, headers: privateHeaders });
  }

  try {
    const recording = await registerRecording(userId, parsed.data);
    return NextResponse.json(RecordingCreateResponseSchema.parse({ recording }), {
      status: 201,
      headers: privateHeaders,
    });
  } catch (error) {
    if (error instanceof RecordingLimitReached) {
      return NextResponse.json(
        { error: 'limit_reached', message: 'Hai raggiunto il numero massimo di registrazioni.' },
        { status: 409, headers: privateHeaders },
      );
    }
    if (error instanceof InvalidRecordingSource) {
      return NextResponse.json(
        { errors: { fileKey: 'Il file caricato non è un audio valido.' } },
        { status: 400, headers: privateHeaders },
      );
    }
    return NextResponse.json(
      { error: 'recordings_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
