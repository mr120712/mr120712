// @polsia:framework-owned - DO NOT EDIT. Installed by polsia/modules/file-upload@0.3.1.
// Server side of private files: signed links for route handlers and server
// components that have already authorized the visitor for every key.
// biome-ignore lint/style/noRestrictedImports: Server-only module; never imported by client components.
import 'server-only';
import { type SignOptions, signedUrlOf } from '@/modules/file-upload/proxy';

export { fileUrl } from '@/modules/file-upload/client';
export type { SignOptions } from '@/modules/file-upload/proxy';

/**
 * Short-lived signed links to private files, by key. A key Polsia does not
 * know for this company, another company's key included, is absent from the
 * Map. Never store or cache the links; render `fileUrl(key)` instead when the
 * page can.
 */
export async function signFileUrls(
  keys: readonly string[],
  options: SignOptions = {},
): Promise<Map<string, string>> {
  // shortcut: N keys = N Polsia calls, add a batch sign on Polsia if a real list needs it
  const urls = await Promise.all(keys.map((key) => signedUrlOf(key, options)));
  const links = new Map<string, string>();
  for (const [index, key] of keys.entries()) {
    const url = urls[index];
    if (url) {
      links.set(key, url);
    }
  }
  return links;
}
