// @polsia:framework-owned — DO NOT EDIT. Builds the Content-Security-Policy
// applied per-request in proxy.ts.
//
// SECURITY POSTURE (platform decision — not the agent's to change):
//   - script-src stays STRICT: per-request nonce + 'strict-dynamic', and NO
//     'unsafe-inline'/'unsafe-eval' in production. This is the directive that
//     actually stops XSS; it is the non-negotiable rampart.
//   - style-src intentionally allows 'unsafe-inline' (and carries NO nonce).
//     Headless UI primitives (Radix/shadcn poppers, slider, progress, toast, …)
//     position and animate via runtime inline style ATTRIBUTES, which are not
//     nonce-eligible. A nonce on style-src silently breaks them in PRODUCTION
//     (they look fine in dev) while buying only marginal CSS-injection
//     protection. Relaxing style-src — and only style-src — keeps every
//     primitive working with zero per-component effort, with the XSS-critical
//     script-src untouched.
//
// CSP spec note: a nonce on a directive makes 'unsafe-inline' IGNORED, so to
// allow inline styles we deliberately do NOT put a nonce on style-src.
//
// PER-APP SEAM: buildCsp accepts `extra` source allow-lists (from cspExtraSources
// in next.user-config.ts) and appends them to the RESOURCE directives only —
// frame-src, connect-src, media-src, font-src, img-src. It never touches
// script-src or style-src (the strict script-src is the XSS rampart), and it
// drops wildcard / execution-escape tokens (see FORBIDDEN_SOURCE) so a per-app
// list can never silently gut the policy. connect-src always carries the
// platform upload host (R2_UPLOAD_HOST) on top of self and the API URL.

/** Extra CSP source allow-lists an app can add via next.user-config.ts. */
export type CspExtraSources = {
  /** third-party <iframe> hosts (Stripe, YouTube, reCAPTCHA, maps, Calendly). */
  frameSrc?: string[];
  /** fetch/XHR/WebSocket/SSE origins beyond self, NEXT_PUBLIC_API_URL and the R2 upload host. */
  connectSrc?: string[];
  /** <audio>/<video> hosts beyond the base `https:` allowance (rare). */
  mediaSrc?: string[];
  /** web-font hosts (next/font self-hosts, so this is rarely needed). */
  fontSrc?: string[];
  /** image hosts beyond the base `https:` allowance (rare). */
  imgSrc?: string[];
};

// Tokens that would defeat an allow-list seam: a bare wildcard and the
// script/style execution escapes never belong in per-app resource sources.
// They are dropped, not honored — the strict script-src rampart lives on its
// own directive, which this seam never feeds.
const FORBIDDEN_SOURCE = new Set([
  '*',
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'unsafe-hashes'",
  "'strict-dynamic'",
]);

// Where the file-upload module PUTs end-user files: Polsia's Cloudflare R2 S3
// endpoint (signed URLs only work on that host, never on a custom domain).
// Constant across every app and environment, so it lives here rather than in a
// per-app env var. A signed URL is the only write credential; allowing the host
// in connect-src grants nothing by itself.
export const R2_UPLOAD_HOST = 'https://*.r2.cloudflarestorage.com';

// Solco è un'app indipendente: solo l'app stessa può inquadrarsi (niente embedding
// esterno). Condiviso con next.config.ts per le risposte che saltano proxy.ts.
export const DASHBOARD_FRAME_ANCESTORS = "'self'";

// Merge a directive's base tokens with any per-app extras: split on whitespace,
// drop forbidden and duplicate tokens, preserve order (base first, 'self' leads).
function sourceList(base: string, extra: string[] = []): string {
  const seen = new Set<string>();
  for (const part of [base, ...extra]) {
    for (const token of (part ?? '').split(/\s+/)) {
      const t = token.trim();
      if (!t || FORBIDDEN_SOURCE.has(t) || seen.has(t)) continue;
      seen.add(t);
    }
  }
  return [...seen].join(' ');
}

export function buildCsp(
  nonce: string,
  isDev: boolean,
  apiUrl = '',
  extra: CspExtraSources = {},
  // proxy.ts passes DASHBOARD_FRAME_ANCESTORS. Keep the 'none' default: existing apps'
  // user-owned tests/unit/csp.test.ts asserts it, and template upgrades never update it.
  frameAncestors = "'none'",
): string {
  return `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''};
    style-src 'self' 'unsafe-inline';
    img-src ${sourceList("'self' blob: data: https:", extra.imgSrc)};
    font-src ${sourceList("'self' data:", extra.fontSrc)};
    connect-src ${sourceList(`'self' ${apiUrl} ${R2_UPLOAD_HOST}`, extra.connectSrc)};
    media-src ${sourceList("'self' blob: https:", extra.mediaSrc)};
    frame-src ${sourceList("'self'", extra.frameSrc)};
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors ${frameAncestors};
    upgrade-insecure-requests;
  `
    .replace(/\s{2,}/g, ' ')
    .trim();
}
