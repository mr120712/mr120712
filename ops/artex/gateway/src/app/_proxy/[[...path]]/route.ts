import { env } from '@/lib/env';

/**
 * Reverse-proxy to ARTEX for every authenticated request.
 *
 * This route is reached ONLY after the Next.js middleware verifies a valid
 * Better Auth session and rewrites the request URL from /<anything> to
 * /_proxy/<anything>. Unauthenticated callers are redirected to /login before
 * they ever land here, so by construction every request we forward carries a
 * verified session cookie — which we strip before passing to ARTEX so the
 * gateway's own cookie does not leak upstream.
 *
 * What we forward: method, path, query, body, almost all headers. What we
 * strip: hop-by-hop headers (RFC 7230 §6.1) and the gateway's own cookie. We
 * add X-Forwarded-* so ARTEX's own logger records the client, not us.
 *
 * Streaming: Node's fetch returns a ReadableStream body; we pass it straight
 * through the Response constructor so SSE and large downloads stay streamed.
 *
 * NOT supported: WebSocket upgrades. ARTEX's UI runs over HTTP/SSE for live
 * task updates (confirmed from the /function/tasks path pattern), so this is
 * fine for now; if WS is ever added we will need to bypass the gateway for
 * /ws at the Caddy layer.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Not hop-by-hop by spec, but we always recompute it:
  'host',
  'content-length',
]);

// Gateway's own cookie prefix, from src/lib/auth.ts advanced.cookiePrefix.
const GATEWAY_COOKIE_PREFIX = 'artex-gateway';

function filterRequestHeaders(headers: Headers, upstream: URL, clientIp: string): Headers {
  const out = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'cookie') {
      // Strip gateway's own cookies; keep anything ARTEX itself set.
      const kept = value
        .split(/;\s*/)
        .filter((c) => !c.startsWith(`${GATEWAY_COOKIE_PREFIX}.`) && !c.startsWith(`__Secure-${GATEWAY_COOKIE_PREFIX}.`))
        .join('; ');
      if (kept) out.set('cookie', kept);
      continue;
    }
    out.set(name, value);
  }
  out.set('host', upstream.host);
  const existingFor = headers.get('x-forwarded-for');
  out.set('x-forwarded-for', existingFor ? `${existingFor}, ${clientIp}` : clientIp);
  out.set('x-forwarded-proto', 'https');
  out.set('x-forwarded-host', headers.get('host') ?? new URL(env.GATEWAY_URL).host);
  out.set('x-real-ip', clientIp);
  return out;
}

function filterResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out.append(name, value);
  }
  return out;
}

async function proxy(request: Request, pathSegments: string[] | undefined): Promise<Response> {
  const upstreamBase = env.ARTEX_UPSTREAM_URL.replace(/\/+$/, '');
  const reqUrl = new URL(request.url);
  const suffix = (pathSegments ?? []).map(encodeURIComponent).join('/');
  const upstreamUrl = new URL(`${upstreamBase}/${suffix}${reqUrl.search}`);

  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';
  const headers = filterRequestHeaders(request.headers, upstreamUrl, clientIp);

  // GET/HEAD can't have a body; every other method streams the request body through.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
    // Required by Node's fetch when streaming a request body.
    duplex: hasBody ? 'half' : undefined,
    body: hasBody ? request.body : undefined,
  };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'upstream_unreachable',
        message: err instanceof Error ? err.message : 'unknown',
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers),
  });
}

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handler(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxy(request, path);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as HEAD, handler as OPTIONS };
