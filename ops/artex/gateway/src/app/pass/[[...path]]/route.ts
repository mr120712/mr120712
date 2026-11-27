import { env } from '@/lib/env';
import { getArtexToken, invalidateArtexToken } from '@/lib/artex-session';

/**
 * Reverse-proxy to ARTEX for every authenticated request.
 *
 * Reached only after Better Auth middleware verifies the gateway session and
 * rewrites /<anything> to /pass/<anything>. Strips the gateway's own cookies
 * before forwarding (so they don't leak upstream), then injects
 *   Authorization: Bearer <ARTEX JWT>
 * from the in-memory ARTEX session (see @/lib/artex-session) so the single
 * authenticated user never sees ARTEX's own login screen.
 *
 * If ARTEX returns 401 (password rotated, version bumped, cached JWT stale),
 * we invalidate the cached JWT, re-login, and retry the request once. For
 * safety we only retry idempotent requests with no streamed body; a POST with
 * a ReadableStream body cannot be replayed (the stream was already consumed
 * by the first fetch), so for those we surface the 401 verbatim — the browser
 * can retry.
 *
 * Streaming: Node's fetch returns a ReadableStream body; we pass it straight
 * through the Response constructor so SSE and large downloads stay streamed.
 *
 * NOT supported: WebSocket upgrades. ARTEX runs over HTTP/SSE for live task
 * updates, so this is fine for now.
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
  // We own the ARTEX auth header; a stray one from the browser would confuse
  // ARTEX (which treats Bearer as a session). Always replace with our token.
  'authorization',
]);

// Gateway's own cookie prefix, from src/lib/auth.ts advanced.cookiePrefix.
const GATEWAY_COOKIE_PREFIX = 'artex-gateway';

function filterRequestHeaders(headers: Headers, upstream: URL, clientIp: string, artexToken: string): Headers {
  const out = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'cookie') {
      // Strip gateway's own cookies; also strip any stale artex_token the
      // browser might carry from an older flow. ARTEX auth now rides on the
      // Authorization header we inject below.
      const kept = value
        .split(/;\s*/)
        .filter(
          (c) =>
            !c.startsWith(`${GATEWAY_COOKIE_PREFIX}.`) &&
            !c.startsWith(`__Secure-${GATEWAY_COOKIE_PREFIX}.`) &&
            !c.startsWith('artex_token='),
        )
        .join('; ');
      if (kept) out.set('cookie', kept);
      continue;
    }
    out.set(name, value);
  }
  out.set('host', upstream.host);
  out.set('authorization', `Bearer ${artexToken}`);
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

async function forwardOnce(
  request: Request,
  upstreamUrl: URL,
  clientIp: string,
  bufferedBody: ArrayBuffer | null,
  hasBody: boolean,
): Promise<Response> {
  const token = await getArtexToken();
  const headers = filterRequestHeaders(request.headers, upstreamUrl, clientIp, token);

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
    duplex: hasBody && bufferedBody === null ? 'half' : undefined,
    body: hasBody ? (bufferedBody ?? request.body) : undefined,
  };

  return await fetch(upstreamUrl, init);
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

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  // For 401-retry safety we need to replay the request body. We buffer it
  // only for the method/path combos that commonly get a stale-token 401 and
  // whose bodies are bounded (JSON APIs). Large uploads (multipart to
  // /api/chat/upload) are streamed without buffering, and the single retry is
  // skipped for them; the browser can re-submit.
  let bufferedBody: ArrayBuffer | null = null;
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  const isReplayable = hasBody && !contentType.startsWith('multipart/');
  if (isReplayable) {
    try {
      bufferedBody = await request.arrayBuffer();
    } catch {
      bufferedBody = null;
    }
  }

  let upstream: Response;
  try {
    upstream = await forwardOnce(request, upstreamUrl, clientIp, bufferedBody, hasBody);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'upstream_unreachable', message: err instanceof Error ? err.message : 'unknown' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  // Stale token recovery: ARTEX returns 401 when the cached JWT no longer
  // matches auth.password_version. Re-login once and retry — but only if we
  // can replay the body (or there isn't one).
  if (upstream.status === 401 && (bufferedBody !== null || !hasBody)) {
    invalidateArtexToken();
    try {
      upstream = await forwardOnce(request, upstreamUrl, clientIp, bufferedBody, hasBody);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'upstream_unreachable', message: err instanceof Error ? err.message : 'unknown' }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    }
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
