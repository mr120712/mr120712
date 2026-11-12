// @polsia:user-owned

import 'server-only';
import { auth } from '@/lib/auth';
import { UploadAuthorization } from '@/modules/file-upload/proxy';

/**
 * Decides whether the visitor behind `request` may upload files. Called first
 * by POST /api/upload (signed link and multipart fallback) and by
 * POST /api/upload/confirm; anything but `Allow` answers 401 `unauthorized`.
 *
 * Any signed-in user may upload. This matches `requireAuth` (the gate used by
 * every recording route: register/list/stream/publish/report), so a user who
 * can register a recording can also upload its bytes — needed so that recording
 * and file upload on /registra work for all signed-in users, not just admins.
 * Per-purpose authorization stays at each feature's own route: the admin
 * "music rights" uploads are gated separately by /api/admin/music-rights, and
 * the recording caps (MAX_RECORDINGS_PER_USER) + rights attestation + community
 * moderation live in the recordings layer. Generic file *downloads* stay closed
 * (see download-policy.server.ts); recordings are streamed only by their own
 * owner-gated route.
 */
export async function authorizeUpload(request: Request): Promise<UploadAuthorization> {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ? UploadAuthorization.Allow : UploadAuthorization.Deny;
}
