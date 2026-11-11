// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// Browser side of the upload data plane:
//
//   browser --POST /api/upload {filename, mime_type, size}--> app --> Polsia
//   browser <--{upload_id, upload_url, headers}-------------- app
//   browser --PUT upload_url (file bytes)-------------------> storage
//   browser --POST /api/upload/confirm {upload_id}----------> app --> Polsia
//   browser <--{file: {key, url, ...}}----------------------- app
//
// Mint and PUT are never retried. Confirm is idempotent upstream, so a timeout,
// a 5xx or `copy_unavailable` replays it with the SAME upload_id (bounded).
// When Polsia answers `direct_upload_disabled` (kill switch), the file goes
// through the classic multipart upload instead, before any PUT.
// uploadPrivateFile() takes the same path with `visibility: 'private'`.
import {
  DownloadQuery,
  FileVisibility,
  PrivateConfirmResponse,
  type PrivateFile,
  UploadConfirmResponse,
  UploadErrorBody,
  type UploadedFile,
  type UploadRequest,
  UploadTicket,
} from '@/lib/contracts/file-upload';

export type { PrivateFile, UploadedFile } from '@/lib/contracts/file-upload';

export type FileUploadErrorCode =
  | 'file_too_large'
  | 'invalid_file_type'
  | 'upload_rejected'
  | 'upload_changed'
  | 'upload_not_found'
  | 'copy_unavailable'
  | 'unauthorized'
  | 'private_storage_unavailable'
  | 'network'
  | 'unknown';

export interface UploadOptions {
  /** Called with 0..100 while the bytes are being sent to storage. */
  onProgress?: (percent: number) => void;
}

const MINT_PATH = '/api/upload';
const CONFIRM_PATH = '/api/upload/confirm';
const JSON_CONTENT_TYPE = 'application/json';
const MULTIPART_FIELD = 'file';
const VISIBILITY_FIELD = 'visibility';
const FILES_ROUTE = '/api/files/';
const KEY_SEPARATOR = '/';
const DIRECT_UPLOAD_DISABLED = 'direct_upload_disabled';
const COPY_UNAVAILABLE = 'copy_unavailable';
const PERCENT_MAX = 100;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;
const HTTP_SERVER_ERROR_MIN = 500;
/** Longer than the app's own 90 s confirm timeout, so its 502 wins when Polsia hangs. */
const CONFIRM_TIMEOUT_MS = 100_000;
/** Wait before each confirm replay: 3 attempts in total. */
const CONFIRM_RETRY_DELAYS_MS = [1_000, 3_000];

const MESSAGES: Record<FileUploadErrorCode, string> = {
  file_too_large: 'This file is too large.',
  invalid_file_type: 'This file type is not supported.',
  upload_rejected: 'The upload was rejected.',
  upload_changed: 'The file changed during the upload. Please select it again.',
  upload_not_found: 'The upload expired. Please select the file again.',
  copy_unavailable: 'Storage is busy right now. Please try again in a minute.',
  unauthorized: 'You are not allowed to upload files. Please sign in and try again.',
  private_storage_unavailable: 'Private file storage is not available for this app yet.',
  network: 'The upload could not be completed. Please check your connection and try again.',
  unknown: 'The upload failed. Please try again.',
};

/** Polsia error codes folded into the stable codes the UI branches on. */
const UPSTREAM_CODES: Record<string, FileUploadErrorCode> = {
  file_too_large: 'file_too_large',
  invalid_file_type: 'invalid_file_type',
  unsupported_image_format: 'invalid_file_type',
  missing_file: 'invalid_file_type',
  upload_rejected: 'upload_rejected',
  upload_changed: 'upload_changed',
  upload_not_found: 'upload_not_found',
  copy_unavailable: 'copy_unavailable',
  unauthorized: 'unauthorized',
  private_storage_unavailable: 'private_storage_unavailable',
};

/**
 * Upload failure with a stable `code`. `message` is always the module's own
 * user-facing text for that code, safe to show as is.
 */
export class FileUploadError extends Error {
  constructor(
    readonly code: FileUploadErrorCode,
    /** Upstream message or HTTP status, for logs. Never shown to the user. */
    readonly detail?: string,
    /** Bytes allowed for this file type, when the server said so. */
    readonly maxSize?: number,
  ) {
    super(MESSAGES[code]);
    this.name = 'FileUploadError';
  }
}

/** Status and parsed JSON body (null when absent or not JSON) of one HTTP exchange. */
interface Reply {
  status: number;
  body: unknown;
}

function isSuccess(status: number): boolean {
  return status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX;
}

function networkError(): FileUploadError {
  return new FileUploadError('network');
}

function upstreamCode(body: unknown): string | null {
  const parsed = UploadErrorBody.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}

function toUploadError(body: unknown): FileUploadError {
  const parsed = UploadErrorBody.safeParse(body);
  if (!parsed.success) {
    return new FileUploadError('unknown');
  }
  const { code, message, max_size } = parsed.data.error;
  return new FileUploadError(UPSTREAM_CODES[code] ?? 'unknown', message, max_size);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same-origin JSON POST. Throws only when no HTTP answer came back (network, timeout). */
async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Reply> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** XHR transport, the only one that reports upload progress. Rejects on network failure. */
function send(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress?: UploadOptions['onProgress'],
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (!onProgress || !event.lengthComputable) {
        return;
      }
      onProgress(Math.round((event.loaded / event.total) * PERCENT_MAX));
    };
    xhr.onload = () => resolve({ status: xhr.status, body: parseJson(xhr.responseText) });
    xhr.onerror = () => reject(networkError());
    xhr.send(body);
  });
}

/** Asks for a signed link. Null means direct upload is switched off: use multipart. */
async function mint(file: File, visibility?: FileVisibility): Promise<UploadTicket | null> {
  const input: UploadRequest = { filename: file.name, mime_type: file.type, size: file.size };
  if (visibility) {
    input.visibility = visibility;
  }
  const reply = await postJson(MINT_PATH, input).catch(() => {
    throw networkError();
  });
  if (!isSuccess(reply.status) && upstreamCode(reply.body) === DIRECT_UPLOAD_DISABLED) {
    return null;
  }
  if (!isSuccess(reply.status)) {
    throw toUploadError(reply.body);
  }
  const ticket = UploadTicket.safeParse(reply.body);
  if (!ticket.success) {
    throw new FileUploadError('unknown');
  }
  return ticket.data;
}

/** PUTs the bytes to the signed link with exactly the headers Polsia signed. Never retried. */
async function putFile(file: File, ticket: UploadTicket, onProgress?: UploadOptions['onProgress']) {
  const reply = await send('PUT', ticket.upload_url, file, ticket.headers, onProgress);
  if (!isSuccess(reply.status)) {
    throw new FileUploadError('unknown', `Storage refused the upload (HTTP ${reply.status}).`);
  }
}

/** Body of a successful confirm or multipart reply; throws its FileUploadError otherwise. */
function receiptBody(reply: Reply): unknown {
  if (!isSuccess(reply.status)) {
    throw toUploadError(reply.body);
  }
  return reply.body;
}

function toUploadedFile(reply: Reply): UploadedFile {
  const confirmed = UploadConfirmResponse.safeParse(receiptBody(reply));
  if (!confirmed.success) {
    throw new FileUploadError('unknown');
  }
  return confirmed.data.file;
}

/** Refuses any receipt that is not explicitly private: such a file would be public. */
function toPrivateFile(reply: Reply): PrivateFile {
  const confirmed = PrivateConfirmResponse.safeParse(receiptBody(reply));
  if (!confirmed.success) {
    throw new FileUploadError('unknown', 'Polsia did not store the file privately.');
  }
  const { key, filename, mime_type, size, created_at } = confirmed.data.file;
  return { key, filename, mime_type, size, created_at };
}

/** A confirm worth replaying with the same upload_id: no answer, a 5xx or `copy_unavailable`. */
function isTransient(reply: Reply | null): boolean {
  if (!reply) {
    return true;
  }
  return reply.status >= HTTP_SERVER_ERROR_MIN || upstreamCode(reply.body) === COPY_UNAVAILABLE;
}

/** Confirms the upload, replaying the SAME upload_id on transient failures. Never re-mints. */
async function confirm(uploadId: string): Promise<Reply> {
  let reply: Reply | null = null;
  for (const delay of [0, ...CONFIRM_RETRY_DELAYS_MS]) {
    if (delay > 0) {
      await wait(delay);
    }
    const signal = AbortSignal.timeout(CONFIRM_TIMEOUT_MS);
    reply = await postJson(CONFIRM_PATH, { upload_id: uploadId }, signal).catch(() => null);
    if (!isTransient(reply)) {
      break;
    }
  }
  if (!reply) {
    throw networkError();
  }
  return reply;
}

/** Kill-switch path: the classic multipart upload, relayed by the app's /api/upload. */
function sendMultipart(
  file: File,
  visibility?: FileVisibility,
  onProgress?: UploadOptions['onProgress'],
): Promise<Reply> {
  const form = new FormData();
  if (visibility) {
    form.append(VISIBILITY_FIELD, visibility);
  }
  form.append(MULTIPART_FIELD, file);
  return send('POST', MINT_PATH, form, {}, onProgress);
}

/** Mint, PUT and confirm, or the multipart fallback: the final reply, not parsed yet. */
async function transfer(
  file: File,
  options: UploadOptions,
  visibility?: FileVisibility,
): Promise<Reply> {
  if (!file.type) {
    throw new FileUploadError('invalid_file_type');
  }
  const ticket = await mint(file, visibility);
  if (!ticket) {
    return sendMultipart(file, visibility, options.onProgress);
  }
  await putFile(file, ticket, options.onProgress);
  return confirm(ticket.upload_id);
}

/**
 * Uploads one file and returns the registered record. Persist `key` and `url`
 * in the app's own model; the signed link is single-use and expires.
 * Throws FileUploadError.
 */
export async function uploadFile(file: File, options: UploadOptions = {}): Promise<UploadedFile> {
  const uploaded = toUploadedFile(await transfer(file, options));
  options.onProgress?.(PERCENT_MAX);
  return uploaded;
}

/**
 * Uploads one file to private storage: it has no URL, only short-lived signed
 * links served by `/api/files/<key>` once `authorizeDownload()` allows the
 * visitor. Persist `key` in the app's own model, owned by the uploading user.
 * Throws FileUploadError (`private_storage_unavailable` while Polsia has not
 * enabled private storage for this app).
 */
export async function uploadPrivateFile(
  file: File,
  options: UploadOptions = {},
): Promise<PrivateFile> {
  const uploaded = toPrivateFile(await transfer(file, options, FileVisibility.Private));
  options.onProgress?.(PERCENT_MAX);
  return uploaded;
}

/** Download link options of `fileUrl`. */
export interface FileUrlOptions {
  /** Saved as a file instead of shown in the browser. */
  download?: boolean;
  /** Saved name with `download`, e.g. the name the user uploaded; default: the stored name. */
  filename?: string;
}

/**
 * Same-origin URL of a private file, e.g. `/api/files/company_42/private/files/<uuid>.pdf`,
 * or `...pdf?download=true&filename=facture.pdf` for a Download button.
 * Safe to render and cache: it redirects to a fresh signed link per request.
 * `next/image` needs `unoptimized` for it (only `/assets/**` is a local pattern).
 */
export function fileUrl(key: string, options: FileUrlOptions = {}): string {
  const path = `${FILES_ROUTE}${key.split(KEY_SEPARATOR).map(encodeURIComponent).join(KEY_SEPARATOR)}`;
  if (!options.download) {
    return path;
  }
  const query = new URLSearchParams({ [DownloadQuery.Download]: DownloadQuery.On });
  if (options.filename) {
    query.set(DownloadQuery.Filename, options.filename);
  }
  return `${path}?${query}`;
}
