// @polsia:framework-owned - DO NOT EDIT. CSRF guard for mutating /api route handlers.
//
// Behind the platform proxy, `request.url` carries the INTERNAL host
// (e.g. http://10.0.0.12:3000), never the public one. Comparing the browser's
// Origin against `new URL(request.url).origin` therefore refuses every real
// request. The public origin comes from NEXT_PUBLIC_APP_URL instead.
import { env } from '@/lib/env';

const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const WILDCARD = '*';

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
 * Origins this app is served on: the baked public URL plus any exact brand
 * domains in BETTER_AUTH_TRUSTED_ORIGINS. Wildcards are ignored.
 */
function allowedOrigins(request: Request): Set<string> {
  const allowed = new Set<string>();

  const baked = exactOrigin(env.NEXT_PUBLIC_APP_URL ?? request.url);
  if (baked) {
    allowed.add(baked);
  }

  for (const entry of (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(',')) {
    const origin = exactOrigin(entry.trim());
    if (origin) {
      allowed.add(origin);
    }
  }
  return allowed;
}

/**
 * True when the browser's `Origin` header is one of the hosts this app is served
 * on. Call it first in every mutating `/api` handler (POST/PUT/PATCH/DELETE) and
 * answer 403 when it is false. A missing `Origin` is refused.
 *
 * @example
 * if (!sameOrigin(request)) {
 *   return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
 * }
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    return false;
  }
  return allowedOrigins(request).has(origin);
}
