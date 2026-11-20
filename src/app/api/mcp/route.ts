// @polsia:user-owned — POST /api/mcp: server MCP (Streamable HTTP) OSPITATO da Solco, con URL
// pubblico. Autentica col Bearer (FREELLMAPI_API_KEY) — header Authorization, o ?key= per i client
// che accettano solo un URL — e delega a handleMcpMessage. È un endpoint MACCHINA autenticato dal
// token: niente sameOrigin (nessun cookie; il Bearer È l'autenticazione), niente gate UAM (/api è
// esente). GET risponde 405 (nessuno stream SSE lato server). CORS aperto: endpoint pubblico a token.
import 'server-only';
import { NextResponse } from 'next/server';
import { bearerMatches, reserveSecret } from '@/lib/business/ai-reserve-connector.server';
import { handleMcpMessage, type JsonRpcMessage } from '@/lib/business/mcp-reserve.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una chat di ripiego può aspettare l'upstream: resta sotto il tetto della route.
export const maxDuration = 60;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
};
const BASE_HEADERS = { 'cache-control': 'no-store', ...CORS };

/** Il token: prima dall'header Authorization: Bearer, poi da ?key= (per i client solo-URL). */
function mcpToken(request: Request): string | null {
  const header = (request.headers.get('authorization') ?? '').trim();
  const fromHeader = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (fromHeader) return fromHeader;
  try {
    return new URL(request.url).searchParams.get('key')?.trim() || null;
  } catch {
    return null;
  }
}

function rpcError(
  status: number,
  code: number,
  message: string,
  extra: Record<string, string> = {},
) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code, message } },
    { status, headers: { ...BASE_HEADERS, ...extra } },
  );
}

export async function POST(request: Request) {
  const secret = reserveSecret();
  if (!secret) return rpcError(503, -32000, 'mcp_not_configured');
  const token = mcpToken(request);
  if (!token || !bearerMatches(token, secret)) {
    return rpcError(401, -32001, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  // Tetto per IP (stesso della «Riserva AI»): ogni chiamata agli strumenti inoltra ai provider
  // gratuiti. Mantiene la forma JSON-RPC ma riusa il Retry-After del rate limiter.
  const limited = await enforceRateLimit('ai.reserve', getRateLimitIdentity(null, request.headers));
  if (limited) {
    return rpcError(429, -32002, 'rate_limited', {
      'Retry-After': limited.headers.get('Retry-After') ?? '60',
    });
  }

  const body = (await request.json().catch(() => null)) as JsonRpcMessage | JsonRpcMessage[] | null;
  if (body === null || typeof body !== 'object') return rpcError(400, -32700, 'parse error');

  // JSON-RPC batch (client più vecchi): rispondi solo ai messaggi con id.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMcpMessage(m)))).filter(
      (r): r is object => r !== null,
    );
    if (responses.length === 0)
      return new NextResponse(null, { status: 202, headers: BASE_HEADERS });
    return NextResponse.json(responses, { status: 200, headers: BASE_HEADERS });
  }

  const response = await handleMcpMessage(body);
  if (response === null) return new NextResponse(null, { status: 202, headers: BASE_HEADERS });
  return NextResponse.json(response, { status: 200, headers: BASE_HEADERS });
}

export function GET() {
  return new NextResponse('Method Not Allowed', {
    status: 405,
    headers: { ...BASE_HEADERS, Allow: 'POST, OPTIONS' },
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
