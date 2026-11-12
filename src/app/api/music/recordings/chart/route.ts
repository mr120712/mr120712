// @polsia:user-owned — classifica ascolti locali: le registrazioni dell'utente per numero di ascolti.
import 'server-only';
import { NextResponse } from 'next/server';
import { RecordingChartResponseSchema } from '@/lib/contracts/recordings';
import { listRecordingsChart } from '@/lib/music/recordings.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

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
    const items = await listRecordingsChart(auth.user.id);
    return NextResponse.json(RecordingChartResponseSchema.parse({ items }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'recordings_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
