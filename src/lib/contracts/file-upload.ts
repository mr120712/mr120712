// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// Shared zod contract for the upload data plane: the /api/upload route
// handlers and the browser-side uploadFile() parse the SAME schemas.
// Client-importable: zod only, no server-only imports.
import { z } from 'zod';

const MAX_NAME_LENGTH = 255;

/** Where Polsia stores a file: `public` (absent) has a permanent URL, `private` only signed links. */
export const FileVisibility = {
  Public: 'public',
  Private: 'private',
} as const;

/** Query of a download link, `?download=true&filename=<name>`, as Polsia's `GET /files/<key>` reads it. */
export const DownloadQuery = {
  Download: 'download',
  On: 'true',
  Filename: 'filename',
} as const;

/** Body of `POST /api/upload`: what the browser knows about the file before sending it. */
export const UploadRequest = z.object({
  filename: z.string().min(1).max(MAX_NAME_LENGTH),
  mime_type: z.string().min(1).max(MAX_NAME_LENGTH),
  size: z.number().int().positive(),
  visibility: z.enum([FileVisibility.Public, FileVisibility.Private]).optional(),
});

/** Response of `POST /api/upload`: a signed link the browser PUTs the bytes to. */
export const UploadTicket = z.object({
  upload_id: z.string().min(1),
  upload_url: z.string().url(),
  expires_at: z.string(),
  headers: z.record(z.string()),
});

/** Body of `POST /api/upload/confirm`. */
export const UploadConfirmRequest = z.object({
  upload_id: z.string().min(1),
});

/** File record returned once Polsia has verified and registered the upload. */
export const UploadedFile = z.object({
  id: z.number(),
  key: z.string(),
  url: z.string().url(),
  filename: z.string(),
  mime_type: z.string(),
  size: z.number(),
  created_at: z.string(),
});

/** Response of `POST /api/upload/confirm`. */
export const UploadConfirmResponse = z.object({
  success: z.literal(true),
  file: UploadedFile,
});

/** Private file record: no URL, it is read through a signed link only. */
export const PrivateFile = z.object({
  key: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  size: z.number(),
  created_at: z.string(),
});

/** Response of `POST /api/upload/confirm` for a private upload: Polsia says it stored it privately. */
export const PrivateConfirmResponse = z.object({
  success: z.literal(true),
  file: PrivateFile.extend({
    url: z.null(),
    visibility: z.literal(FileVisibility.Private),
  }),
});

/** Error envelope shared by Polsia and the app's own route handlers. */
export const UploadErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    reason: z.string().optional(),
    max_size: z.number().optional(),
  }),
});

export type FileVisibility = (typeof FileVisibility)[keyof typeof FileVisibility];
export type UploadRequest = z.infer<typeof UploadRequest>;
export type UploadTicket = z.infer<typeof UploadTicket>;
export type UploadConfirmRequest = z.infer<typeof UploadConfirmRequest>;
export type UploadedFile = z.infer<typeof UploadedFile>;
export type UploadConfirmResponse = z.infer<typeof UploadConfirmResponse>;
export type PrivateFile = z.infer<typeof PrivateFile>;
export type PrivateConfirmResponse = z.infer<typeof PrivateConfirmResponse>;
export type UploadErrorBody = z.infer<typeof UploadErrorBody>;
