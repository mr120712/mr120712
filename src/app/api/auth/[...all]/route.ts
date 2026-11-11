// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/better-auth@0.12.0. Drift = commit rejected.
//
// better-auth catch-all route handler. Mounts EVERY better-auth endpoint
// (sign-in, sign-up, sign-out, session, callbacks, ...) under /api/auth/*.
// Lives under /api, which proxy.ts's matcher excludes (no CSP/nonce, not proxied).
//
// toNextJsHandler returns native App Router GET/POST handlers — NO Server Actions,
// so the 'nextCookies()' plugin is intentionally absent: cookies are set on the
// route handler's own NextResponse, which Next.js does not discard.

import 'server-only';
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

const handler = toNextJsHandler(auth);

export async function POST(request: Request) {
  return previewIframeResponse(request, await handler.POST(request));
}

// better-auth answers GET /verify-email with raw JSON ({"status":true,"user":null})
// when the link has no callbackURL, e.g. from a custom sender that rebuilt the
// link from the token. A browser opening the email link then never returns to
// the site, and an invalid token shows a JSON error. Default callbackURL to the
// home page for document navigations only: authClient.verifyEmail() fetches
// still receive the JSON they parse.
export async function GET(request: Request) {
  const url = new URL(request.url);
  let authRequest = request;
  if (
    url.pathname.endsWith('/verify-email') &&
    !url.searchParams.get('callbackURL') &&
    isDocumentNavigation(request)
  ) {
    url.searchParams.set('callbackURL', '/');
    authRequest = new Request(url, { method: request.method, headers: request.headers });
  }
  return previewIframeResponse(request, await handler.GET(authRequest));
}

// The Polsia dashboard previews the app in a cross-site iframe, where browsers drop
// SameSite=Lax cookies. auth-client.ts marks requests sent from that iframe (a custom
// header, which only this app's own scripts can send); their cookies become
// partitioned to the dashboard, a session separate from direct visits. The marker
// cookie lets lib/auth.ts refuse that session to cross-origin writes.
function previewIframeResponse(request: Request, response: Response): Response {
  const cookies = response.headers.getSetCookie();
  if (request.headers.get('x-polsia-preview-iframe') !== '1' || cookies.length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  // Same name as PREVIEW_MARKER_COOKIE in lib/auth.ts.
  for (const cookie of [
    ...cookies,
    '__Host-polsia-preview=1; Path=/; Max-Age=34560000; HttpOnly',
  ]) {
    const parts = cookie.split(';').map((part) => part.trim());
    // A cookie the app already made cross-site keeps the app's own attributes.
    if (parts.some((part) => /^samesite=none$/i.test(part))) {
      headers.append('set-cookie', cookie);
      continue;
    }
    const attributes = parts.filter(
      (part) => !/^(?:samesite|secure|partitioned)(?:=|$)/i.test(part),
    );
    headers.append(
      'set-cookie',
      [...attributes, 'SameSite=None', 'Secure', 'Partitioned'].join('; '),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isDocumentNavigation(request: Request) {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return request.headers.get('accept')?.includes('text/html') ?? false;
}
