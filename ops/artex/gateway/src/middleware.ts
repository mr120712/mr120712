import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Edge middleware that owns the whole hostname.
 *
 * Flow:
 *   1. /login, /api/auth/*, static assets, favicon → let through unchanged
 *   2. Anywhere else, if a valid Better Auth session cookie is present
 *      (signature verified at edge, no DB call) → rewrite to /_proxy/<path>
 *      and the proxy route forwards to ARTEX
 *   3. Anywhere else, no session → 302 to /login?next=<original>
 *
 * We deliberately do NOT call the auth API here — that would need a DB round
 * trip per request. `getSessionCookie` verifies the HMAC on the cookie value
 * with BETTER_AUTH_SECRET, which is enough to know the session was issued by
 * our server; actual expiry/revocation is still enforced on the next DB touch.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // Public paths — never gated. /__gw_assets/* serves the gateway's own
  // chunks (assetPrefix in next.config.ts); it must be reachable without a
  // session so the /login page can hydrate.
  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/__gw_assets/') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt'
  ) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request, { cookiePrefix: 'artex-gateway' });

  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/' || search) {
      loginUrl.searchParams.set('next', `${pathname}${search}`);
    }
    return NextResponse.redirect(loginUrl);
  }

  // Already on the proxy path (either a direct hit or an internal rewrite
  // from below). Session is valid, let the route handler forward upstream.
  if (pathname === '/pass' || pathname.startsWith('/pass/')) {
    return NextResponse.next();
  }

  // Authenticated. Rewrite to /pass/<original path> so the catch-all handler
  // forwards to ARTEX while the user's address bar keeps the real URL.
  const proxyUrl = new URL(`/pass${pathname === '/' ? '' : pathname}`, request.url);
  proxyUrl.search = search;
  return NextResponse.rewrite(proxyUrl);
}

export const config = {
  // Match everything. The gateway's own Next.js chunks live under
  // /__gw_assets/* (see assetPrefix in next.config.ts) and are allowed
  // through by the public-paths check in middleware(); every /_next/* path
  // left on the host belongs to ARTEX and must be proxied.
  matcher: ['/((?!__gw_assets).*)'],
};
