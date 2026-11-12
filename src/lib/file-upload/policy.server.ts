// @polsia:user-owned

import 'server-only';
import { auth } from '@/lib/auth';
import { UploadAuthorization } from '@/modules/file-upload/proxy';

/**
 * Decides whether the visitor behind `request` may upload files. Called first
 * by POST /api/upload (signed link and multipart fallback) and by
 * POST /api/upload/confirm; anything but `Allow` answers 401 `unauthorized`.
 *
 * Only verified admins may upload. The sole upload surface left is the admin
 * "music rights" tool (gated again by /api/admin/music-rights); the user-facing
 * recording/upload feature was removed. Generic file *downloads* stay closed too
 * (see download-policy.server.ts).
 */
export async function authorizeUpload(request: Request): Promise<UploadAuthorization> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.role === 'admin' && session.user.emailVerified === true
    ? UploadAuthorization.Allow
    : UploadAuthorization.Deny;
}
