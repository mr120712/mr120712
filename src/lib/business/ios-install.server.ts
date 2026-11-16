// @polsia:user-owned — l'app iOS distribuita dal sito: l'IPA firmato sta in Vercel Blob PRIVATO
// (prefisso ios-app/, mai leggibile dal suo URL), con un piccolo JSON (ios-app/current.json) che dice
// quale IPA è attivo, la versione e come è firmato. Per l'utente: lo stato e il link itms-services
// con il token (GET /api/ios/install); per l'installatore di iOS: il manifest e il file, verificati
// col token (GET /api/ios/manifest, /api/ios/ipa); per l'amministratore: attivazione dopo ispezione
// dell'IPA (identificativo, versione e firma giusti) e rimozione.
import 'server-only';
import { del, get, list, put } from '@vercel/blob';
import { signIosInstallToken } from '@/lib/business/ios-install-token.server';
import { inspectIpa } from '@/lib/business/ipa-archive';
import {
  type IosAdminStatus,
  type IosInstallStatus,
  type IosIpaRecord,
  IosIpaRecordSchema,
} from '@/lib/contracts/ios-install';
import { env } from '@/lib/env';
import {
  IOS_APP_BUNDLE_ID,
  IOS_APP_TITLE,
  IOS_APP_VERSION,
  IOS_IPA_BLOB_PREFIX,
  IOS_IPA_INSTALLABLE_METHODS,
  IOS_IPA_MAX_BYTES,
  IOS_IPA_META_PATHNAME,
  IOS_MANIFEST_PATH,
  isIosIpaPathname,
  itmsServicesUrl,
} from '@/lib/ios-app';
import { siteUrl } from '@/lib/site';

const UPSTREAM_TIMEOUT_MS = 20_000;
const INSPECT_TIMEOUT_MS = 90_000;

/** Il token dello store, o null (installazione dal sito spenta) se Vercel Blob non è configurato. */
export function iosBlobToken(): string | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  return typeof token === 'string' && token ? token : null;
}

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function logFailure(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token o URL).
  console.error(`[ios-install] ${what}:`, error instanceof Error ? error.name : typeof error);
}

/** Vero se l'URL è un blob dello store di Solco sotto il prefisso dell'app iOS. */
export function isIosIpaBlobUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.blob.vercel-storage.com')) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return false;
  }
  return isIosIpaPathname(pathname) && pathname.startsWith(IOS_IPA_BLOB_PREFIX);
}

export function isInstallableMethod(method: IosIpaRecord['method']): boolean {
  return IOS_IPA_INSTALLABLE_METHODS.includes(method);
}

/** L'IPA attivo (ios-app/current.json); null se assente, illeggibile o store spento. */
export async function readIosIpaRecord(
  token: string | null = iosBlobToken(),
): Promise<IosIpaRecord | null> {
  if (!token) return null;
  try {
    const result = await get(IOS_IPA_META_PATHNAME, {
      access: 'private',
      token,
      abortSignal: abortAfter(UPSTREAM_TIMEOUT_MS),
    });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    const parsed = IosIpaRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeIosIpaRecord(record: IosIpaRecord, token: string): Promise<void> {
  await put(IOS_IPA_META_PATHNAME, JSON.stringify(record), {
    access: 'private',
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    abortSignal: abortAfter(UPSTREAM_TIMEOUT_MS),
  });
}

/** Stato per l'utente autenticato: con un IPA installabile, il link itms-services col suo token. */
export async function iosInstallStatusFor(userId: string): Promise<IosInstallStatus> {
  const base: IosInstallStatus = {
    available: false,
    bundleId: IOS_APP_BUNDLE_ID,
    version: null,
    method: null,
    uploadedAt: null,
    installUrl: null,
    expiresAt: null,
    reason: null,
  };
  const token = iosBlobToken();
  if (!token) return { ...base, reason: 'not_configured' };
  const record = await readIosIpaRecord(token);
  if (!record) return { ...base, reason: 'none' };
  const meta = { version: record.version, method: record.method, uploadedAt: record.uploadedAt };
  if (!isInstallableMethod(record.method)) return { ...base, ...meta, reason: 'method' };
  const signed = signIosInstallToken(userId);
  if (!signed) return { ...base, ...meta, reason: 'not_configured' };
  const manifestUrl = `${siteUrl}${IOS_MANIFEST_PATH}?t=${encodeURIComponent(signed.token)}`;
  return {
    ...base,
    ...meta,
    available: true,
    installUrl: itmsServicesUrl(manifestUrl),
    expiresAt: new Date(signed.expiresAt).toISOString(),
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Il manifest che Safari passa all'installatore (itms-services): dove sta l'IPA e di che app è. */
export function buildIosManifest(input: {
  ipaUrl: string;
  bundleId: string;
  version: string;
  title?: string;
  iconUrl: string;
  fullSizeIconUrl: string;
}): string {
  const asset = (kind: string, url: string) =>
    `      <dict>\n        <key>kind</key>\n        <string>${kind}</string>\n        <key>url</key>\n        <string>${escapeXml(url)}</string>\n      </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
${asset('software-package', input.ipaUrl)}
${asset('display-image', input.iconUrl)}
${asset('full-size-image', input.fullSizeIconUrl)}
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(input.bundleId)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(input.version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(input.title ?? IOS_APP_TITLE)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

/** Apre l'IPA attivo dallo store privato per ritrasmetterlo all'installatore. */
export async function openIosIpa(
  record: IosIpaRecord,
  token: string | null = iosBlobToken(),
): Promise<{ stream: ReadableStream<Uint8Array>; contentLength: string | null } | null> {
  if (!token) return null;
  try {
    const result = await get(record.url, {
      access: 'private',
      token,
      abortSignal: abortAfter(UPSTREAM_TIMEOUT_MS),
    });
    if (!result || !result.stream) return null;
    return { stream: result.stream, contentLength: result.headers.get('content-length') };
  } catch (error) {
    logFailure('IPA non leggibile', error);
    return null;
  }
}

/** Legge un blob privato in memoria, fermandosi oltre il limite. */
async function readBlobFully(url: string, token: string, maxBytes: number): Promise<Buffer | null> {
  const result = await get(url, {
    access: 'private',
    token,
    abortSignal: abortAfter(INSPECT_TIMEOUT_MS),
  });
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function deleteQuietly(urls: string[], token: string) {
  const targets = urls.filter((url) => url);
  if (targets.length === 0) return;
  try {
    await del(targets, { token, abortSignal: abortAfter(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    logFailure('pulizia dello store non riuscita', error);
  }
}

export type IosIpaActivation =
  | { ok: true; record: IosIpaRecord }
  | { ok: false; status: 400 | 502 | 503; error: string; message: string };

export async function adminIosStatus(): Promise<IosAdminStatus> {
  const token = iosBlobToken();
  return {
    configured: token !== null,
    current: token ? await readIosIpaRecord(token) : null,
    expectedBundleId: IOS_APP_BUNDLE_ID,
    expectedVersion: IOS_APP_VERSION,
  };
}

/**
 * Attiva l'IPA appena caricato dall'amministratore: lo legge dallo store, lo ispeziona (identificativo,
 * versione e firma) e, se va bene, lo registra come attivo e cancella quello precedente. Un IPA
 * sbagliato viene cancellato subito dallo store.
 */
export async function activateIosIpa(input: {
  blobUrl: string;
  size: number;
}): Promise<IosIpaActivation> {
  const token = iosBlobToken();
  if (!token) {
    return {
      ok: false,
      status: 503,
      error: 'not_configured',
      message: 'Lo store dei file (Vercel Blob) non è configurato sul server.',
    };
  }
  if (!isIosIpaBlobUrl(input.blobUrl) || input.size > IOS_IPA_MAX_BYTES) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_blob',
      message: 'Il file caricato non è un IPA dello store di Solco.',
    };
  }
  let bytes: Buffer | null;
  try {
    bytes = await readBlobFully(input.blobUrl, token, IOS_IPA_MAX_BYTES);
  } catch (error) {
    logFailure('lettura del file caricato', error);
    bytes = null;
  }
  if (!bytes) {
    await deleteQuietly([input.blobUrl], token);
    return {
      ok: false,
      status: 502,
      error: 'unreadable',
      message: 'Il file caricato non si legge dallo store: riprova il caricamento.',
    };
  }
  const inspection = inspectIpa(bytes, { bundleId: IOS_APP_BUNDLE_ID, version: IOS_APP_VERSION });
  if (!inspection.ok) {
    await deleteQuietly([input.blobUrl], token);
    return { ok: false, status: 400, error: inspection.error, message: inspection.message };
  }
  const pathname = decodeURIComponent(new URL(input.blobUrl).pathname.replace(/^\/+/, ''));
  const record: IosIpaRecord = {
    version: inspection.version,
    bundleId: inspection.bundleId,
    pathname,
    url: input.blobUrl,
    sizeBytes: bytes.length,
    uploadedAt: new Date().toISOString(),
    method: inspection.method,
    devices: inspection.devices,
  };
  const previous = await readIosIpaRecord(token);
  try {
    await writeIosIpaRecord(record, token);
  } catch (error) {
    logFailure('registrazione dell’IPA attivo', error);
    await deleteQuietly([input.blobUrl], token);
    return {
      ok: false,
      status: 502,
      error: 'store_write',
      message: 'Lo store non ha accettato la registrazione del nuovo IPA: riprova.',
    };
  }
  if (previous && previous.url !== record.url) await deleteQuietly([previous.url], token);
  return { ok: true, record };
}

/** Rimuove l'IPA attivo e ogni file dell'app iOS rimasto nello store (anche caricamenti mai attivati). */
export async function removeIosIpa(): Promise<{ removed: number } | null> {
  const token = iosBlobToken();
  if (!token) return null;
  const urls: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await list({
        prefix: IOS_IPA_BLOB_PREFIX,
        token,
        cursor,
        limit: 200,
        abortSignal: abortAfter(UPSTREAM_TIMEOUT_MS),
      });
      urls.push(...page.blobs.map((blob) => blob.url));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    logFailure('elenco dello store', error);
    return null;
  }
  await deleteQuietly(urls, token);
  return { removed: urls.length };
}
