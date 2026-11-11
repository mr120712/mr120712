// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

export type VerifiedMusicRightsAdmin = { id: string };
export type MusicRightsAdminAccess =
  | { allowed: true; user: VerifiedMusicRightsAdmin }
  | { allowed: false; response: Response };

function denied(error: string, status: number): MusicRightsAdminAccess {
  return {
    allowed: false,
    response: NextResponse.json({ error }, { status, headers: privateHeaders }),
  };
}

/** Rights records can be changed only from a verified server-side admin session. */
export async function requireVerifiedMusicRightsAdmin(
  request: Request,
): Promise<MusicRightsAdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return denied('unauthorized', 401);
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return denied('admin_required', 403);
    }
    return { allowed: true, user: { id: session.user.id } };
  } catch {
    return denied('session_unavailable', 503);
  }
}

export { privateHeaders as musicRightsPrivateHeaders };
