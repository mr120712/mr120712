// @polsia:user-owned

import 'server-only';
import { auth } from '@/lib/auth';
import { UploadAuthorization } from '@/modules/file-upload/proxy';

/**
 * Decides whether the visitor behind `request` may upload files. Called first
 * by POST /api/upload (signed link and multipart fallback) and by
 * POST /api/upload/confirm; anything but `Allow` answers 401 `unauthorized`.
 *
 * The company API key only identifies the app, so this default denies every
 * upload. Rename `_request` to `request` and replace the body with one of:
 *
 *   // Signed-in users only (better-auth installed; import { auth } from '@/lib/auth'):
 *   const session = await auth.api.getSession({ headers: request.headers });
 *   return session?.user ? UploadAuthorization.Allow : UploadAuthorization.Deny;
 *
 *   // Anonymous uploads, only when the product explicitly wants them:
 *   return UploadAuthorization.Allow;
 */
export async function authorizeUpload(request: Request): Promise<UploadAuthorization> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.role === 'admin' && session.user.emailVerified === true
    ? UploadAuthorization.Allow
    : UploadAuthorization.Deny;
}
