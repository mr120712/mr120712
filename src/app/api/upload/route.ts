// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// POST /api/upload: mints a signed upload link from Polsia. The browser then
// PUTs the file bytes straight to storage; they never transit through here.
// Exception: while Polsia's kill switch is on, uploadFile() posts the file here
// as multipart and it is streamed to Polsia's classic upload.
import 'server-only';
import { UploadRequest } from '@/lib/contracts/file-upload';
import { authorizeUpload } from '@/lib/file-upload/policy.server';
import {
  isMultipartUpload,
  mintUpload,
  readUploadBody,
  relayMultipart,
  UploadAuthorization,
  unauthorized,
} from '@/modules/file-upload/proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if ((await authorizeUpload(request)) !== UploadAuthorization.Allow) {
    return unauthorized();
  }
  if (isMultipartUpload(request)) {
    return relayMultipart(request);
  }
  const input = await readUploadBody(request, UploadRequest);
  if (input instanceof Response) {
    return input;
  }
  return mintUpload(input);
}
