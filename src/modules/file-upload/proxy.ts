// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// biome-ignore lint/style/noRestrictedImports: Governed server-only relay; never imported by client components.
import 'server-only';
import type { ZodType } from 'zod';
import {
  DownloadQuery,
  type UploadConfirmRequest,
  type UploadRequest,
} from '@/lib/contracts/file-upload';
import { env } from '@/lib/env';

const R2_PROXY_PATH = '/api/proxy/r2';
const MINT_PATH = '/uploads';
const CONFIRM_PATH = '/uploads/confirm';
const MULTIPART_PATH = '/upload';
const FILES_PATH = '/files/';
const JSON_CONTENT_TYPE = 'application/json';
const MULTIPART_CONTENT_TYPE = 'multipart/form-data';
const MINT_TIMEOUT_MS = 20_000;
/** An R2 server-side copy of a large file can take well over 20 s. */
const CONFIRM_TIMEOUT_MS = 90_000;
/** The multipart fallback carries the bytes (up to 1 GB), so it gets far longer. */
const MULTIPART_TIMEOUT_MS = 600_000;
const SIGN_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4_096;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const RESPONSE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
/**
 * The app's 302 to a signed link: browser cache only, 300 s, under Polsia's
 * shortest default link lifetime (600 s), so a cached redirect never points
 * to an expired link. The Referer would leak the app path to storage.
 */
const SIGNED_REDIRECT_HEADERS = {
  'cache-control': 'private, max-age=300',
  'referrer-policy': 'no-referrer',
};
const INVALID_REQUEST = 'invalid_request';
const FORBIDDEN_ORIGIN = 'forbidden_origin';
const FORBIDDEN_ORIGIN_MESSAGE = 'This request is not allowed.';
const UNAUTHORIZED = 'unauthorized';
const UNAUTHORIZED_MESSAGE = 'You are not allowed to upload files.';
const FILE_NOT_FOUND = 'file_not_found';
const FILE_NOT_FOUND_MESSAGE = 'File not found.';
const KEY_SEPARATOR = '/';
/** Key segments refused before any call: they would rewrite the Polsia path. */
const UNSAFE_KEY_SEGMENTS = ['', '.', '..'];
const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const WILDCARD = '*';
/** `<slug>.[staging.]polsia.(app|io)`: one app served on both platform domains. */
const PLATFORM_HOST = /^([a-z0-9-]+)\.(staging\.)?polsia\.(app|io)$/;

/**
 * Decision of the app's `authorizeUpload()` policy
 * (src/lib/file-upload/policy.server.ts). Anything but `Allow` is refused.
 */
export const UploadAuthorization = {
  Allow: 'allow',
  Deny: 'deny',
} as const;

export type UploadAuthorization = (typeof UploadAuthorization)[keyof typeof UploadAuthorization];

/**
 * Decision of the app's `authorizeDownload()` policy
 * (src/lib/file-upload/download-policy.server.ts). Anything but `Allow` is a 404.
 */
export const DownloadAuthorization = {
  Allow: 'allow',
  Deny: 'deny',
} as const;

export type DownloadAuthorization =
  (typeof DownloadAuthorization)[keyof typeof DownloadAuthorization];

/** Signed link options; only the ones given are sent, Polsia picks the rest. */
export interface SignOptions {
  /** Link lifetime, 60 to 3600 s. Default: 600 s, 3600 s for video and audio. */
  ttlSeconds?: number;
  /** Served as an attachment instead of inline. */
  download?: boolean;
  /** Download name with `download`; default: the stored name. */
  filename?: string;
}

/** Error envelope, same shape as Polsia's so the browser needs one parser. */
function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: RESPONSE_HEADERS });
}

function forbiddenOrigin(): Response {
  return failure(HTTP_FORBIDDEN, FORBIDDEN_ORIGIN, FORBIDDEN_ORIGIN_MESSAGE);
}

/** 401 sent when the app's upload policy did not allow the request. */
export function unauthorized(): Response {
  return failure(HTTP_UNAUTHORIZED, UNAUTHORIZED, UNAUTHORIZED_MESSAGE);
}

/** 404 for a refused download and an unknown file alike, so a refusal reveals nothing. */
export function fileNotFound(): Response {
  return failure(HTTP_NOT_FOUND, FILE_NOT_FOUND, FILE_NOT_FOUND_MESSAGE);
}

/** 302 to a signed link, cacheable by the visitor's browser only. */
export function signedRedirect(url: string): Response {
  return new Response(null, {
    status: HTTP_FOUND,
    headers: { location: url, ...SIGNED_REDIRECT_HEADERS },
  });
}

/**
 * R2 proxy base URL, resolved at request time: POLSIA_R2_BASE_URL, falling
 * back to POLSIA_API_BASE_URL for deployments that only inject the general
 * API origin. Null when neither is configured.
 */
function r2BaseUrl(): string | null {
  const origin = env.POLSIA_R2_BASE_URL || process.env.POLSIA_API_BASE_URL;
  if (!origin) {
    return null;
  }
  return `${origin.replace(/\/+$/, '')}${R2_PROXY_PATH}`;
}

/** Exact HTTP(S) origin of `value`, or null for wildcards, credentials and garbage. */
function exactOrigin(value: string): string | null {
  if (value.includes(WILDCARD)) {
    return null;
  }
  try {
    const url = new URL(value);
    if (!ALLOWED_PROTOCOLS.includes(url.protocol) || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The other platform domain of the same app: `acme.polsia.io` <-> `acme.polsia.app`
 * (staging too), same protocol and port. Null for any other host.
 */
function platformTwin(origin: string): string | null {
  const url = new URL(origin);
  const match = PLATFORM_HOST.exec(url.hostname);
  if (!match) {
    return null;
  }
  const [, slug, staging = '', domain] = match;
  url.hostname = `${slug}.${staging}polsia.${domain === 'app' ? 'io' : 'app'}`;
  return url.origin;
}

/**
 * Origins this app is served on: the baked public URL, its platform twin, and
 * the exact brand domains Polsia injects at deploy. Wildcards are ignored: every
 * tenant shares `*.polsia.app`, so they would trust other companies' pages.
 */
function allowedOrigins(request: Request): Set<string> {
  const allowed = new Set<string>();
  const baked = exactOrigin(env.NEXT_PUBLIC_APP_URL ?? request.url);
  if (baked) {
    allowed.add(baked);
    const twin = platformTwin(baked);
    if (twin) {
      allowed.add(twin);
    }
  }
  for (const entry of (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',')) {
    const origin = exactOrigin(entry.trim());
    if (origin) {
      allowed.add(origin);
    }
  }
  return allowed;
}

/** The browser's Origin must be one of the hosts this app is served on. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    return false;
  }
  return allowedOrigins(request).has(origin);
}

/** Reads at most MAX_BODY_BYTES of the body as text; null when it is larger. */
async function readText(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
  }
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Served-host-only, JSON-only, size-capped body parse against a shared contract.
 * Returns the parsed input, or the error Response to send straight back.
 */
export async function readUploadBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<T | Response> {
  if (!sameOrigin(request)) {
    return forbiddenOrigin();
  }
  if (!request.headers.get('content-type')?.startsWith(JSON_CONTENT_TYPE)) {
    return failure(HTTP_BAD_REQUEST, INVALID_REQUEST, 'Expected a JSON body.');
  }
  const text = await readText(request);
  if (text === null) {
    return failure(HTTP_PAYLOAD_TOO_LARGE, INVALID_REQUEST, 'The request is too large.');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure(HTTP_BAD_REQUEST, INVALID_REQUEST, 'Malformed JSON body.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request.';
    return failure(HTTP_BAD_REQUEST, INVALID_REQUEST, detail);
  }
  return parsed.data;
}

/**
 * POSTs to the R2 proxy with the company credential and replays status + JSON body.
 * `body` is JSON for mint/confirm, the raw multipart stream for the fallback.
 */
async function relay(
  path: string,
  body: BodyInit,
  contentType: string,
  timeoutMs: number,
): Promise<Response> {
  const base = r2BaseUrl();
  if (!env.POLSIA_API_KEY || !base) {
    return failure(
      HTTP_SERVICE_UNAVAILABLE,
      'not_configured',
      'File upload is not configured yet. Please try again later.',
    );
  }
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.POLSIA_API_KEY}`,
      'content-type': contentType,
    },
    body,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    // Streams the multipart body instead of buffering the file in the app.
    duplex: 'half',
  };
  try {
    const upstream = await fetch(`${base}${path}`, init);
    const payload: unknown = await upstream.json();
    return Response.json(payload, { status: upstream.status, headers: RESPONSE_HEADERS });
  } catch {
    return failure(
      HTTP_BAD_GATEWAY,
      'upstream_unavailable',
      'Polsia could not be reached. Please try again.',
    );
  }
}

/** Asks Polsia for a signed upload link. Replays the upstream status and body. */
export function mintUpload(input: UploadRequest): Promise<Response> {
  return relay(MINT_PATH, JSON.stringify(input), JSON_CONTENT_TYPE, MINT_TIMEOUT_MS);
}

/** Tells Polsia the bytes are in storage; Polsia verifies, registers and returns the file record. */
export function confirmUpload(input: UploadConfirmRequest): Promise<Response> {
  return relay(CONFIRM_PATH, JSON.stringify(input), JSON_CONTENT_TYPE, CONFIRM_TIMEOUT_MS);
}

/** True for the kill-switch fallback: the browser posts the file itself as multipart. */
export function isMultipartUpload(request: Request): boolean {
  return request.headers.get('content-type')?.startsWith(MULTIPART_CONTENT_TYPE) ?? false;
}

/**
 * Kill-switch fallback: streams the browser's multipart body, boundary included,
 * to Polsia's classic upload. Polsia enforces types and sizes; the reply is the
 * same `{success, file}` record as a confirm.
 */
export async function relayMultipart(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type');
  if (!sameOrigin(request)) {
    return forbiddenOrigin();
  }
  if (!request.body || !contentType) {
    return failure(HTTP_BAD_REQUEST, INVALID_REQUEST, 'Expected a file.');
  }
  return relay(MULTIPART_PATH, request.body, contentType, MULTIPART_TIMEOUT_MS);
}

/** `company_1/private/a b.pdf` -> `company_1/private/a%20b.pdf`; null for an empty or dot segment. */
function filePath(key: string): string | null {
  const segments = key.split(KEY_SEPARATOR);
  if (segments.some((segment) => UNSAFE_KEY_SEGMENTS.includes(segment))) {
    return null;
  }
  return segments.map(encodeURIComponent).join(KEY_SEPARATOR);
}

/** `?download=true[&filename=]` of a `fileUrl` link; any other query is dropped. */
export function downloadOptionsOf(request: Request): SignOptions {
  const query = new URL(request.url).searchParams;
  if (query.get(DownloadQuery.Download) !== DownloadQuery.On) {
    return {};
  }
  return { download: true, filename: query.get(DownloadQuery.Filename) || undefined };
}

function signQuery({ ttlSeconds, download, filename }: SignOptions): string {
  const query = new URLSearchParams();
  if (ttlSeconds !== undefined) {
    query.set('ttl_seconds', String(ttlSeconds));
  }
  if (download) {
    query.set(DownloadQuery.Download, DownloadQuery.On);
  }
  if (filename !== undefined) {
    query.set(DownloadQuery.Filename, filename);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

/**
 * Signed link to one file of this company: the `Location` of the 302 Polsia's
 * `GET /files/<key>` answers. Null for an unknown key, another company's key,
 * a refused option, a missing configuration or an unreachable Polsia.
 */
export async function signedUrlOf(key: string, options: SignOptions): Promise<string | null> {
  const base = r2BaseUrl();
  const path = filePath(key);
  if (!env.POLSIA_API_KEY || !base || !path) {
    return null;
  }
  try {
    const upstream = await fetch(`${base}${FILES_PATH}${path}${signQuery(options)}`, {
      headers: { authorization: `Bearer ${env.POLSIA_API_KEY}` },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
    });
    await upstream.body?.cancel();
    return upstream.status === HTTP_FOUND ? upstream.headers.get('location') : null;
  } catch {
    return null;
  }
}
