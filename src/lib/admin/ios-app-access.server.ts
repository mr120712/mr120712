// @polsia:user-owned — accesso alle API admin dell'app iOS (/api/admin/ios-app/**): sessione con
// ruolo admin ed email verificata, come le altre route /api/admin/**; risposte JSON mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

export const iosAdminPrivateHeaders = { 'cache-control': 'private, no-store', vary: 'Cookie' };

export type IosAdminAccess =
  | { allowed: true; userId: string }
  | { allowed: false; response: Response };

export function iosAdminJson(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: iosAdminPrivateHeaders });
}

export async function requireIosAdmin(request: Request): Promise<IosAdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) {
      return { allowed: false, response: iosAdminJson({ error: 'unauthorized' }, 401) };
    }
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return { allowed: false, response: iosAdminJson({ error: 'forbidden' }, 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: iosAdminJson({ error: 'session_unavailable' }, 503) };
  }
}
