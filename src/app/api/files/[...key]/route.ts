// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// GET /api/files/<key>: the URL fileUrl(key) renders. Asks the app's
// authorizeDownload() first, then 302s to a fresh signed link. A refusal and
// an unknown file are the same 404. `<Image>` needs `unoptimized` for it.
import 'server-only';
import { authorizeDownload } from '@/lib/file-upload/download-policy.server';
import {
  DownloadAuthorization,
  downloadOptionsOf,
  fileNotFound,
  signedRedirect,
} from '@/modules/file-upload/proxy';
import { signFileUrls } from '@/modules/file-upload/server';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string[] }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const key = (await context.params).key.join('/');
  if ((await authorizeDownload(request, key)) !== DownloadAuthorization.Allow) {
    return fileNotFound();
  }
  const url = (await signFileUrls([key], downloadOptionsOf(request))).get(key);
  if (!url) {
    return fileNotFound();
  }
  return signedRedirect(url);
}
