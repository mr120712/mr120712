// @polsia:user-owned

import 'server-only';
import { DownloadAuthorization } from '@/modules/file-upload/proxy';

/** Generic file downloads stay closed; track bytes use the protected stream route. */
export async function authorizeDownload(
  _request: Request,
  _key: string,
): Promise<DownloadAuthorization> {
  // Private music files are streamed only by the Pro-and-rights-gated route.
  return DownloadAuthorization.Deny;
}
