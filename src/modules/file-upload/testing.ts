// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// Sample answers of the upload routes, for the app's tests. Polsia storage
// cannot be called while the app is built: test against these answers and
// never invent another one. Keys, ids and URLs are fake. No env, no network:
// safe in any test. Usage in AGENT.md (Testing).
import {
  FileVisibility,
  type PrivateConfirmResponse,
  type PrivateFile,
  type UploadConfirmResponse,
  type UploadErrorBody,
  type UploadedFile,
  type UploadTicket,
} from '@/lib/contracts/file-upload';

const JSON_HEADERS = { 'content-type': 'application/json' };

const HTTP_STATUS = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  payloadTooLarge: 413,
  serviceUnavailable: 503,
} as const;

/** 20 MB, the image limit `file_too_large` reports in `max_size`. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const CREATED_AT = '2026-09-22T10:00:01.000Z';

/** One answer: its HTTP status and JSON body. */
export interface FileUploadAnswer<Body = unknown> {
  readonly status: number;
  readonly body: Body;
}

/** What `uploadFile()` resolves to: a public record with a permanent `url`. */
export const SAMPLE_UPLOADED_FILE: UploadedFile = {
  id: 7,
  key: 'company_1/images/0b8f1f2e-6c1a-4f4e-9d59-3f0b7f7f2a11.png',
  url: 'https://files.example.com/company_1/images/0b8f1f2e-6c1a-4f4e-9d59-3f0b7f7f2a11.png',
  filename: 'photo.png',
  mime_type: 'image/png',
  size: 4,
  created_at: CREATED_AT,
};

/** What `uploadPrivateFile()` resolves to: a `key`, no `url`. */
export const SAMPLE_PRIVATE_FILE: PrivateFile = {
  key: 'company_1/private/documents/5d2c7a90-1e4b-4c8a-a3f6-8b9e0d1c2f34.pdf',
  filename: '5d2c7a90-1e4b-4c8a-a3f6-8b9e0d1c2f34.pdf',
  mime_type: 'application/pdf',
  size: 4,
  created_at: CREATED_AT,
};

function rejection(
  status: number,
  code: string,
  message: string,
): FileUploadAnswer<UploadErrorBody> {
  return { status, body: { error: { code, message } } };
}

/** Every answer the upload routes and Polsia's `DELETE /files/<key>` give, by name. */
export const FILE_UPLOAD_ANSWERS = {
  /** `POST /api/upload`: the signed link the browser PUTs the bytes to. */
  mint: {
    status: HTTP_STATUS.ok,
    body: {
      upload_id: 'company_1/0b8f1f2e-6c1a-4f4e-9d59-3f0b7f7f2a11.png',
      upload_url: 'https://storage.example.com/company_1/0b8f1f2e.png?signature=sample',
      expires_at: '2026-09-22T11:00:00.000Z',
      headers: { 'Content-Type': 'image/png' },
    } satisfies UploadTicket,
  },
  /** The PUT to `upload_url`: storage answers 200 with no body. */
  stored: { status: HTTP_STATUS.ok, body: null },
  /** `POST /api/upload/confirm` of `uploadFile()`. */
  confirmed: {
    status: HTTP_STATUS.ok,
    body: { success: true, file: SAMPLE_UPLOADED_FILE } satisfies UploadConfirmResponse,
  },
  /** `POST /api/upload/confirm` of `uploadPrivateFile()`. */
  confirmedPrivate: {
    status: HTTP_STATUS.ok,
    body: {
      success: true,
      file: { ...SAMPLE_PRIVATE_FILE, url: null, visibility: FileVisibility.Private },
    } satisfies PrivateConfirmResponse,
  },
  /** `authorizeUpload()` refused the visitor: `FileUploadError` `unauthorized`. */
  unauthorized: rejection(
    HTTP_STATUS.unauthorized,
    'unauthorized',
    'You are not allowed to upload files.',
  ),
  /** Over the limit of its type: `FileUploadError` `file_too_large`, `maxSize` set. */
  fileTooLarge: {
    status: HTTP_STATUS.payloadTooLarge,
    body: {
      error: {
        code: 'file_too_large',
        message: 'File exceeds maximum size of 20MB for images',
        max_size: IMAGE_MAX_BYTES,
      },
    } satisfies UploadErrorBody,
  },
  /** A type outside the table: `FileUploadError` `invalid_file_type`. */
  invalidFileType: rejection(
    HTTP_STATUS.badRequest,
    'invalid_file_type',
    'File type image/heic is not allowed.',
  ),
  /** Private storage off for this app: `FileUploadError` `private_storage_unavailable`. */
  privateStorageUnavailable: rejection(
    HTTP_STATUS.forbidden,
    'private_storage_unavailable',
    'Private storage is not available for this app.',
  ),
  /** Kill switch on: the client sends the file as multipart, nothing for the app to handle. */
  directUploadDisabled: rejection(
    HTTP_STATUS.serviceUnavailable,
    'direct_upload_disabled',
    'Direct upload is disabled. Send the file to POST /upload instead.',
  ),
  /** Polsia's `DELETE /files/<key>`: the file is gone, drop the row. */
  deleted: {
    status: HTTP_STATUS.ok,
    body: {
      success: true,
      deleted: { key: SAMPLE_UPLOADED_FILE.key, filename: SAMPLE_UPLOADED_FILE.filename },
    },
  },
  /** `DELETE /files/<key>` of a file already gone: drop the row too. */
  fileNotFound: rejection(HTTP_STATUS.notFound, 'file_not_found', 'File not found'),
} satisfies Record<string, FileUploadAnswer>;

/**
 * A `fetch` stub answering `answer`, for server code that calls Polsia (a
 * DELETE route). Wrap it in `vi.fn()` to assert the request it received.
 */
export function fileUploadFetch(answer: FileUploadAnswer): typeof fetch {
  return async () =>
    new Response(answer.body === null ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: JSON_HEADERS,
    });
}
