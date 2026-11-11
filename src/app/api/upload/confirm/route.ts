// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// POST /api/upload/confirm: once the browser has PUT the bytes, asks Polsia to
// verify and register the upload. Returns the file record to persist.
import 'server-only';
import { UploadConfirmRequest } from '@/lib/contracts/file-upload';
import { authorizeUpload } from '@/lib/file-upload/policy.server';
import {
  confirmUpload,
  readUploadBody,
  UploadAuthorization,
  unauthorized,
} from '@/modules/file-upload/proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if ((await authorizeUpload(request)) !== UploadAuthorization.Allow) {
    return unauthorized();
  }
  const input = await readUploadBody(request, UploadConfirmRequest);
  if (input instanceof Response) {
    return input;
  }
  return confirmUpload(input);
}
